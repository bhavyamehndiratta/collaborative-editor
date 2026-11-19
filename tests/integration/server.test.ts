import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CrdtDocument } from '../../packages/crdt/src/index.js';
import type { ServerMessage } from '../../packages/protocol/src/index.js';
import { loadConfig } from '../../packages/server/src/config.js';
import { startServer, type RunningServer } from '../../packages/server/src/server.js';

const config = loadConfig({ ...process.env, PORT: '0' });

async function eventually(fn: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function createDoc(port: number, name: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

class TestClient {
  doc: CrdtDocument;
  readonly messages: ServerMessage[] = [];
  docId = '';

  private constructor(
    readonly ws: WebSocket,
    readonly replicaId: string,
    doc?: CrdtDocument,
  ) {
    this.doc = doc ?? new CrdtDocument(replicaId);
    ws.on('message', (data) => this.onMessage(JSON.parse(data.toString()) as ServerMessage));
  }

  static async connect(port: number, replicaId: string, doc?: CrdtDocument): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestClient(ws, replicaId, doc);
  }

  private onMessage(msg: ServerMessage): void {
    this.messages.push(msg);
    if (msg.type === 'snapshot') {
      this.doc = CrdtDocument.fromSnapshot(this.replicaId, msg.snapshot);
    } else if (msg.type === 'ops') {
      for (const op of msg.ops) this.doc.receive(op);
    }
  }

  async join(docId: string, version: Record<string, number> = {}): Promise<void> {
    this.docId = docId;
    const before = this.messages.length;
    this.ws.send(JSON.stringify({ type: 'join', docId, replicaId: this.replicaId, version }));
    await eventually(() => this.messages.length > before);
  }

  type(text: string): void {
    const ops = [...text].map((ch) => this.doc.insert(this.doc.length, ch));
    this.ws.send(JSON.stringify({ type: 'ops', docId: this.docId, ops }));
  }

  ackedCounter(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m !== undefined && m.type === 'ack') return m.version[this.replicaId] ?? 0;
    }
    return 0;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

describe('sync server (real Postgres)', () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer(config);
  });
  afterAll(async () => {
    await server.close();
  });

  it('serves health and lists documents', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const docId = await createDoc(server.port, 'listed');
    const list = (await (await fetch(`http://127.0.0.1:${server.port}/api/docs`)).json()) as {
      id: string;
    }[];
    expect(list.some((d) => d.id === docId)).toBe(true);
  });

  it('converges two clients through the server and acknowledges writes', async () => {
    const docId = await createDoc(server.port, 'converge');
    const a = await TestClient.connect(server.port, 'a');
    const b = await TestClient.connect(server.port, 'b');
    await a.join(docId);
    await b.join(docId);
    a.type('hello');
    await eventually(() => b.doc.text() === 'hello');
    await eventually(() => a.ackedCounter() === 5);
    b.type('!');
    await eventually(() => a.doc.text() === 'hello!');
    expect(b.doc.text()).toBe('hello!');
    await a.close();
    await b.close();
  });

  it('catches a reconnecting client up with only the operations it missed', async () => {
    const docId = await createDoc(server.port, 'reconnect');
    const a = await TestClient.connect(server.port, 'a');
    const b = await TestClient.connect(server.port, 'b');
    await a.join(docId);
    await b.join(docId);
    a.type('abc');
    await eventually(() => b.doc.text() === 'abc');
    const keptDoc = b.doc;
    await b.close();
    a.type('def');
    await eventually(() => a.ackedCounter() === 6);

    const b2 = await TestClient.connect(server.port, 'b', keptDoc);
    await b2.join(docId, keptDoc.version().toJSON());
    const first = b2.messages[0];
    expect(first?.type).toBe('ops');
    if (first?.type === 'ops') expect(first.ops).toHaveLength(3);
    await eventually(() => b2.doc.text() === 'abcdef');
    await a.close();
    await b2.close();
  });

  it('rejects operations whose replica does not match the join', async () => {
    const docId = await createDoc(server.port, 'spoof');
    const b = await TestClient.connect(server.port, 'b');
    await b.join(docId);
    const forged = new CrdtDocument('zz').insert(0, 'x');
    b.ws.send(JSON.stringify({ type: 'ops', docId, ops: [forged] }));
    await eventually(() => b.messages.some((m) => m.type === 'error'));
    await b.close();
  });

  it('rejects an unknown document', async () => {
    const a = await TestClient.connect(server.port, 'a');
    await a.join('00000000-0000-4000-8000-000000000000');
    expect(a.messages.some((m) => m.type === 'error')).toBe(true);
    await a.close();
  });
});

describe('persistence and recovery (real Postgres)', () => {
  it('recovers a document from snapshot plus log after a server restart', async () => {
    const text = 'persist me please';
    const s1 = await startServer({ ...config, snapshotEvery: 5 });
    const docId = await createDoc(s1.port, 'restart');
    const a = await TestClient.connect(s1.port, 'a');
    await a.join(docId);
    a.type(text);
    await eventually(() => a.ackedCounter() === text.length);
    await a.close();
    await s1.close();

    const s2 = await startServer({ ...config, snapshotEvery: 5 });
    const c = await TestClient.connect(s2.port, 'c');
    await c.join(docId);
    expect(c.messages[0]?.type).toBe('snapshot');
    await eventually(() => c.doc.text() === text);
    c.type('!');
    const d = await TestClient.connect(s2.port, 'd');
    await d.join(docId);
    await eventually(() => d.doc.text() === `${text}!`);
    await c.close();
    await d.close();
    await s2.close();
  });
});
