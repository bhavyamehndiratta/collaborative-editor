import { CrdtDocument, type Id, type Operation } from '@collab/crdt';
import type { ClientMessage, PresenceCursor, ServerMessage } from '@collab/protocol';
import type { SavedState, StateStore } from './offline-store.js';

export type Status = 'connecting' | 'online' | 'syncing' | 'offline';

export interface SyncOptions {
  readonly serverUrl: string;
  readonly docId: string;
  readonly replicaId: string;
  readonly name?: string;
  readonly color?: string;
  /** Where to persist the document and unacknowledged operations (IndexedDB in the browser). */
  readonly store?: StateStore | undefined;
  /** State loaded from the store: the client opens offline first and syncs when it can. */
  readonly initial?: SavedState | undefined;
}

export interface RemotePresence {
  readonly replicaId: string;
  readonly name: string;
  readonly color: string;
  readonly cursor: PresenceCursor | null;
}

const BATCH_MS = 30;
const PRESENCE_MS = 50;
const SAVE_MS = 100;
const MAX_OPS_PER_MESSAGE = 5000;
const MAX_NAME = 32;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Framework free sync engine. Owns the local CrdtDocument, batches local operations,
 * tracks which are unacknowledged, shares presence, and reconnects with exponential
 * backoff and jitter.
 */
export class SyncClient {
  onStatus: (status: Status) => void = () => {};
  onReady: () => void = () => {};
  onRemoteChange: () => void = () => {};
  onPresence: () => void = () => {};
  onPending: (count: number) => void = () => {};

  /** Other replicas' presence, keyed by replica id. Ephemeral. */
  readonly remote = new Map<string, RemotePresence>();

  private doc: CrdtDocument;
  private ws: WebSocket | undefined;
  private pending: Operation[] = [];
  private sendQueue: Operation[] = [];
  private flushTimer: Timer | undefined;
  private presenceTimer: Timer | undefined;
  private saveTimer: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private attempt = 0;
  private stopped = false;
  private joined = false;
  private awaitingJoinResponse = false;
  private hasSynced = false;
  private current: Status = 'connecting';
  private localCursor: PresenceCursor | null = null;
  private readonly name: string;
  private readonly color: string;

  constructor(private readonly options: SyncOptions) {
    const initial = options.initial;
    this.doc =
      initial === undefined
        ? new CrdtDocument(options.replicaId)
        : CrdtDocument.fromSnapshot(options.replicaId, initial.snapshot);
    if (initial !== undefined) this.pending = [...initial.pending];
    this.name = options.name ?? options.replicaId.slice(0, MAX_NAME);
    this.color = options.color ?? '#005cc5';
  }

  get status(): Status {
    return this.current;
  }

  get replicaId(): string {
    return this.options.replicaId;
  }

  get unackedCount(): number {
    return this.pending.length;
  }

  text(): string {
    return this.doc.text();
  }

  /** Current index of a presence anchor, or undefined if that element has not arrived yet. */
  resolve(anchor: Id): number | undefined {
    return this.doc.indexOfAnchor(anchor);
  }

  start(): void {
    this.stopped = false;
    if (this.options.initial !== undefined && !this.hasSynced) {
      this.hasSynced = true;
      this.onReady();
      this.onPending(this.pending.length);
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    if (this.presenceTimer !== undefined) clearTimeout(this.presenceTimer);
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.flushSave();
    this.ws?.close();
  }

  /** Closes the socket; the normal reconnect loop brings it back. Used by tests and demos. */
  dropConnection(): void {
    this.ws?.close();
  }

  /** Applies a local edit: delete `deleteCount` characters at `index`, then insert `text` there. */
  applyLocal(index: number, deleteCount: number, text: string): void {
    for (let i = 0; i < deleteCount; i++) this.queue(this.doc.delete(index));
    for (let i = 0; i < text.length; i++) this.queue(this.doc.insert(index + i, text.charAt(i)));
    this.updateStatus();
    this.onPending(this.pending.length);
    this.scheduleSave();
  }

  /** Publishes the local selection (as element ids) to other replicas, throttled. */
  setLocalCursor(anchorIndex: number, headIndex: number): void {
    this.localCursor = {
      anchor: this.doc.anchorAt(anchorIndex),
      head: this.doc.anchorAt(headIndex),
    };
    if (this.presenceTimer === undefined) {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = undefined;
        this.sendPresence();
      }, PRESENCE_MS);
    }
  }

  private sendPresence(): void {
    if (!this.joined) return;
    this.send({
      type: 'presence',
      docId: this.options.docId,
      name: this.name,
      color: this.color,
      cursor: this.localCursor,
    });
  }

  /** Persists the document and unacknowledged ops shortly after a change, so a reload loses nothing. */
  private scheduleSave(): void {
    if (this.options.store === undefined || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_MS);
  }

  flushSave(): void {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const store = this.options.store;
    if (store === undefined) return;
    store
      .save(this.options.docId, {
        replicaId: this.options.replicaId,
        snapshot: this.doc.snapshot(),
        pending: [...this.pending],
      })
      .catch((err: unknown) => console.error('offline save failed', err));
  }

  private queue(op: Operation): void {
    this.pending.push(op);
    this.sendQueue.push(op);
    if (this.flushTimer === undefined) this.flushTimer = setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    const ws = this.ws;
    if (!this.joined || ws === undefined || ws.readyState !== WebSocket.OPEN) return;
    while (this.sendQueue.length > 0) {
      const ops = this.sendQueue.splice(0, MAX_OPS_PER_MESSAGE);
      this.send({ type: 'ops', docId: this.options.docId, ops });
    }
  }

  private send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private connect(): void {
    if (this.stopped) return;
    this.updateStatus();
    const ws = new WebSocket(`${this.options.serverUrl.replace(/^http/, 'ws')}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.awaitingJoinResponse = true;
      this.send({
        type: 'join',
        docId: this.options.docId,
        replicaId: this.options.replicaId,
        version: this.doc.version().toJSON(),
      });
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') this.handle(JSON.parse(event.data) as ServerMessage);
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.joined = false;
        this.awaitingJoinResponse = false;
        if (this.remote.size > 0) {
          this.remote.clear();
          this.onPresence();
        }
        this.updateStatus();
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onJoinResponse(): void {
    if (!this.awaitingJoinResponse) return;
    this.awaitingJoinResponse = false;
    this.joined = true;
    this.attempt = 0;
    this.sendQueue = [...this.pending];
    if (this.sendQueue.length > 0 && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => this.flush(), 0);
    }
    this.sendPresence();
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'snapshot': {
        this.doc = CrdtDocument.fromSnapshot(this.options.replicaId, msg.snapshot);
        this.onJoinResponse();
        this.scheduleSave();
        if (!this.hasSynced) {
          this.hasSynced = true;
          this.updateStatus();
          this.onReady();
        } else {
          this.updateStatus();
          this.onRemoteChange();
        }
        break;
      }
      case 'ops': {
        for (const op of msg.ops) this.doc.receive(op);
        this.onJoinResponse();
        this.scheduleSave();
        this.updateStatus();
        if (this.hasSynced && msg.ops.length > 0) this.onRemoteChange();
        break;
      }
      case 'ack': {
        const covered = msg.version[this.options.replicaId] ?? 0;
        this.pending = this.pending.filter((op) => op.id.counter > covered);
        this.onJoinResponse();
        this.updateStatus();
        this.onPending(this.pending.length);
        this.scheduleSave();
        break;
      }
      case 'presence': {
        if (msg.replicaId === this.options.replicaId) break;
        this.remote.set(msg.replicaId, {
          replicaId: msg.replicaId,
          name: msg.name,
          color: msg.color,
          cursor: msg.cursor,
        });
        this.onPresence();
        break;
      }
      case 'presenceLeave': {
        if (this.remote.delete(msg.replicaId)) this.onPresence();
        break;
      }
      case 'error':
        console.error('server error:', msg.message);
        if (msg.message === 'unknown document') this.stop();
        break;
    }
  }

  private updateStatus(): void {
    let next: Status;
    if (!this.joined) next = this.hasSynced ? 'offline' : 'connecting';
    else next = this.pending.length > 0 ? 'syncing' : 'online';
    if (next !== this.current) {
      this.current = next;
      this.onStatus(next);
    }
  }
}
