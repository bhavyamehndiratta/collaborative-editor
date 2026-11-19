import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CrdtDocument, VersionVector, type Operation } from '@collab/crdt';
import {
  parseClientMessage,
  type JoinMessage,
  type OpsMessage,
  type PresenceBroadcast,
  type PresenceMessage,
  type ServerMessage,
} from '@collab/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ServerConfig } from './config.js';
import { Bus } from './bus.js';
import { Store } from './store.js';

const SERVER_REPLICA = 'server';
const FLUSH_MS = 10;
const HIGH_WATER_BYTES = 1 << 20;
const HARD_LIMIT_BYTES = 16 << 20;
const MAX_BATCH = 2000;
const MAX_OUTBOX_OPS = 200_000;
const HEARTBEAT_MS = 30_000;

type Timer = ReturnType<typeof setTimeout>;

interface Client {
  readonly ws: WebSocket;
  replicaId: string | undefined;
  room: Room | undefined;
  readonly outbox: Operation[];
  timer: Timer | undefined;
  chain: Promise<void>;
}

/** One loaded document. All state changes for a room run one at a time through `run`. */
class Room {
  readonly clients = new Set<Client>();
  /** Ephemeral: last presence per replica. Never persisted, dropped when the replica leaves. */
  readonly presence = new Map<string, PresenceBroadcast>();
  opsSinceSnapshot = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly docId: string,
    readonly doc: CrdtDocument,
    public lastSeq: number,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function sendTo(client: Client, msg: ServerMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
}

function sendOpsNow(client: Client, docId: string, ops: Operation[]): void {
  if (ops.length === 0) {
    sendTo(client, { type: 'ops', docId, ops: [] });
    return;
  }
  for (let i = 0; i < ops.length; i += MAX_BATCH) {
    sendTo(client, { type: 'ops', docId, ops: ops.slice(i, i + MAX_BATCH) });
  }
}

/** Batches outgoing operations and applies backpressure based on the socket's buffered bytes. */
function enqueue(client: Client, docId: string, ops: Operation[]): void {
  for (const op of ops) client.outbox.push(op);
  if (client.outbox.length > MAX_OUTBOX_OPS) {
    client.ws.close(1013, 'slow consumer');
    return;
  }
  if (client.timer === undefined) client.timer = setTimeout(() => flush(client, docId), FLUSH_MS);
}

function flush(client: Client, docId: string): void {
  client.timer = undefined;
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > HARD_LIMIT_BYTES) {
    client.ws.terminate();
    return;
  }
  if (client.ws.bufferedAmount > HIGH_WATER_BYTES) {
    client.timer = setTimeout(() => flush(client, docId), FLUSH_MS * 5);
    return;
  }
  while (client.outbox.length > 0) {
    sendOpsNow(client, docId, client.outbox.splice(0, MAX_BATCH));
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 10_000) throw new HttpError(413, 'body too large');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const store = new Store(config.databaseUrl);
  await store.migrate();
  const rooms = new Map<string, Promise<Room | undefined>>();
  const bus = new Bus(config.redisUrl, randomUUID());
  const logError = (err: unknown): void => console.error(err);

  async function loadRoom(docId: string): Promise<Room | undefined> {
    if (!(await store.docExists(docId))) return undefined;
    // Subscribe before reading the log so no operation can fall in the gap between the two.
    await bus.subscribe(docId);
    const snap = await store.loadSnapshot(docId);
    const doc =
      snap === undefined
        ? new CrdtDocument(SERVER_REPLICA)
        : CrdtDocument.fromSnapshot(SERVER_REPLICA, snap.state);
    let lastSeq = snap?.lastSeq ?? 0;
    // Replay by version vector, not by seq: across instances seq order is not commit order.
    await store.forEachOpNotCovered(docId, doc.version().toJSON(), (ops, maxSeq) => {
      for (const op of ops) doc.receive(op);
      lastSeq = Math.max(lastSeq, maxSeq);
    });
    return new Room(docId, doc, lastSeq);
  }

  function getRoom(docId: string): Promise<Room | undefined> {
    let p = rooms.get(docId);
    if (p === undefined) {
      p = loadRoom(docId);
      rooms.set(docId, p);
      p.then(
        (room) => {
          if (room === undefined) rooms.delete(docId);
        },
        () => rooms.delete(docId),
      );
    }
    return p;
  }

  async function missingOps(room: Room, clientVv: VersionVector): Promise<Operation[]> {
    const out: Operation[] = [];
    for (const [replica, counter] of Object.entries(room.doc.version().toJSON())) {
      const have = clientVv.get(replica);
      if (counter > have) {
        for (const op of await store.opsSince(room.docId, replica, have, counter)) out.push(op);
      }
    }
    return out;
  }

  async function handleJoin(client: Client, msg: JoinMessage): Promise<void> {
    if (client.room !== undefined) {
      sendTo(client, { type: 'error', message: 'already joined a document' });
      return;
    }
    const room = await getRoom(msg.docId);
    if (room === undefined) {
      sendTo(client, { type: 'error', message: 'unknown document' });
      return;
    }
    client.room = room;
    client.replicaId = msg.replicaId;
    await room.run(async () => {
      room.clients.add(client);
      if (Object.keys(msg.version).length === 0) {
        sendTo(client, { type: 'snapshot', docId: room.docId, snapshot: room.doc.snapshot() });
      } else {
        const missing = await missingOps(room, VersionVector.fromJSON(msg.version));
        sendOpsNow(client, room.docId, missing);
      }
      for (const p of room.presence.values()) sendTo(client, p);
      bus.publish(room.docId, { kind: 'presenceSync' });
    });
  }

  async function handleOps(client: Client, msg: OpsMessage): Promise<void> {
    const room = client.room;
    if (room === undefined || client.replicaId === undefined) {
      sendTo(client, { type: 'error', message: 'join a document first' });
      return;
    }
    if (msg.docId !== room.docId) {
      sendTo(client, { type: 'error', message: 'docId does not match the joined document' });
      return;
    }
    if (msg.ops.some((op) => op.id.replica !== client.replicaId)) {
      sendTo(client, { type: 'error', message: 'operation replica does not match join' });
      return;
    }
    await room.run(async () => {
      const { inserted, maxSeq } = await store.appendOps(room.docId, msg.ops);
      // Apply everything in the message (a resend after reconnect may carry operations that are
      // already in Postgres but not yet in this instance's copy), and forward what is new here.
      const fresh: Operation[] = [];
      for (const op of msg.ops) {
        const result = room.doc.receive(op);
        if (result === 'applied' || result === 'buffered') fresh.push(op);
      }
      room.lastSeq = Math.max(room.lastSeq, maxSeq);
      for (const other of room.clients) {
        if (other !== client && fresh.length > 0) enqueue(other, room.docId, fresh);
      }
      // Other instances only need what Postgres did not already have.
      if (inserted.length > 0) bus.publish(room.docId, { kind: 'ops', ops: inserted });
      sendTo(client, { type: 'ack', docId: room.docId, version: room.doc.version().toJSON() });
      room.opsSinceSnapshot += inserted.length;
      if (room.opsSinceSnapshot >= config.snapshotEvery) {
        await store.saveSnapshot(room.docId, room.lastSeq, room.doc.snapshot());
        room.opsSinceSnapshot = 0;
      }
    });
  }

  function handlePresence(client: Client, msg: PresenceMessage): void {
    const room = client.room;
    if (room === undefined || client.replicaId === undefined) {
      sendTo(client, { type: 'error', message: 'join a document first' });
      return;
    }
    if (msg.docId !== room.docId) {
      sendTo(client, { type: 'error', message: 'docId does not match the joined document' });
      return;
    }
    const broadcast: PresenceBroadcast = {
      type: 'presence',
      docId: room.docId,
      replicaId: client.replicaId,
      name: msg.name,
      color: msg.color,
      cursor: msg.cursor,
    };
    room.presence.set(client.replicaId, broadcast);
    for (const other of room.clients) if (other !== client) sendTo(other, broadcast);
    bus.publish(room.docId, { kind: 'presence', presence: broadcast });
  }

  async function handleMessage(client: Client, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      sendTo(client, { type: 'error', message: parsed.error });
      return;
    }
    switch (parsed.message.type) {
      case 'join':
        await handleJoin(client, parsed.message);
        break;
      case 'ops':
        await handleOps(client, parsed.message);
        break;
      case 'presence':
        handlePresence(client, parsed.message);
        break;
    }
  }

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
      } else if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { status: 'ok', instance: config.instanceId });
      } else if (req.method === 'GET' && url.pathname === '/api/docs') {
        json(res, 200, await store.listDocs());
      } else if (req.method === 'POST' && url.pathname === '/api/docs') {
        const body = await readJson(req);
        const name =
          typeof body === 'object' && body !== null && 'name' in body ? body.name : undefined;
        if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
          throw new HttpError(400, 'name must be a non empty string up to 100 characters');
        }
        json(res, 201, await store.createDoc(name.trim()));
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.message });
      } else {
        console.error(err);
        json(res, 500, { error: 'internal error' });
      }
    }
  }

  function withRoom(docId: string, fn: (room: Room) => void): void {
    const pending = rooms.get(docId);
    if (pending === undefined) return;
    pending.then((room) => {
      if (room !== undefined) fn(room);
    }, logError);
  }

  /** Applies operations from the log or another instance and fans them out to local clients. */
  function applyIncoming(room: Room, ops: Operation[]): void {
    const fresh: Operation[] = [];
    for (const op of ops) {
      const result = room.doc.receive(op);
      if (result === 'applied' || result === 'buffered') fresh.push(op);
    }
    if (fresh.length === 0) return;
    for (const c of room.clients) enqueue(c, room.docId, fresh);
  }

  /** Pulls whatever this instance's copy lacks from Postgres, e.g. after Redis was unreachable. */
  async function resync(room: Room): Promise<void> {
    await room.run(async () => {
      await store.forEachOpNotCovered(room.docId, room.doc.version().toJSON(), (ops) =>
        applyIncoming(room, ops),
      );
    });
  }

  bus.onMessage((docId, msg) => {
    withRoom(docId, (room) => {
      switch (msg.kind) {
        case 'ops':
          room.run(() => Promise.resolve(applyIncoming(room, msg.ops))).catch(logError);
          break;
        case 'presence':
          room.presence.set(msg.presence.replicaId, msg.presence);
          for (const c of room.clients) sendTo(c, msg.presence);
          break;
        case 'presenceLeave':
          if (room.presence.delete(msg.replicaId)) {
            for (const c of room.clients) {
              sendTo(c, { type: 'presenceLeave', docId: room.docId, replicaId: msg.replicaId });
            }
          }
          break;
        case 'presenceSync':
          for (const c of room.clients) {
            const p = c.replicaId === undefined ? undefined : room.presence.get(c.replicaId);
            if (p !== undefined) bus.publish(room.docId, { kind: 'presence', presence: p });
          }
          break;
      }
    });
  });

  bus.onReconnect(() => {
    for (const docId of rooms.keys()) withRoom(docId, (room) => void resync(room).catch(logError));
  });

  const httpServer = http.createServer((req, res) => {
    void handleHttp(req, res);
  });
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 1 << 20 });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const client: Client = {
      ws,
      replicaId: undefined,
      room: undefined,
      outbox: [],
      timer: undefined,
      chain: Promise.resolve(),
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        sendTo(client, { type: 'error', message: 'binary messages are not supported' });
        return;
      }
      const raw = rawToString(data);
      client.chain = client.chain
        .then(() => handleMessage(client, raw))
        .catch((err: unknown) => {
          console.error(err);
          sendTo(client, { type: 'error', message: 'internal error' });
        });
    });
    ws.on('error', (err) => console.error('websocket error', err));
    ws.on('close', () => {
      if (client.timer !== undefined) clearTimeout(client.timer);
      const room = client.room;
      if (room !== undefined) {
        room.clients.delete(client);
        const replicaId = client.replicaId;
        if (replicaId !== undefined && room.presence.delete(replicaId)) {
          for (const other of room.clients) {
            sendTo(other, { type: 'presenceLeave', docId: room.docId, replicaId });
          }
          bus.publish(room.docId, { kind: 'presenceLeave', replicaId });
        }
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    async close(): Promise<void> {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await bus.close();
      await store.close();
    },
  };
}
