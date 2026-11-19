import type { Operation } from '@collab/crdt';
import type { PresenceBroadcast } from '@collab/protocol';
import { Redis } from 'ioredis';

const PREFIX = 'collab:doc:';

/** What instances tell each other. Postgres stays the source of truth; Redis is only fan-out. */
export type BusMessage =
  | { readonly kind: 'ops'; readonly ops: Operation[] }
  | { readonly kind: 'presence'; readonly presence: PresenceBroadcast }
  | { readonly kind: 'presenceLeave'; readonly replicaId: string }
  | { readonly kind: 'presenceSync' };

interface Envelope {
  readonly from: string;
  readonly msg: BusMessage;
}

/** Redis pub/sub with one channel per document. Messages from this instance are dropped. */
export class Bus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private handler: (docId: string, msg: BusMessage) => void = () => {};
  private reconnectHandler: () => void = () => {};
  private readyOnce = false;

  constructor(
    url: string,
    private readonly selfId: string,
  ) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
    for (const r of [this.pub, this.sub]) {
      r.on('error', (err: Error) => console.error('redis error:', err.message));
    }
    // A pub/sub connection can miss messages while it is down, so a reconnect triggers a resync.
    this.sub.on('ready', () => {
      if (this.readyOnce) this.reconnectHandler();
      this.readyOnce = true;
    });
    this.sub.on('message', (channel: string, raw: string) => {
      if (!channel.startsWith(PREFIX)) return;
      let env: Envelope;
      try {
        env = JSON.parse(raw) as Envelope;
      } catch {
        return;
      }
      if (env.from === this.selfId) return;
      this.handler(channel.slice(PREFIX.length), env.msg);
    });
  }

  onMessage(handler: (docId: string, msg: BusMessage) => void): void {
    this.handler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  async subscribe(docId: string): Promise<void> {
    await this.sub.subscribe(PREFIX + docId);
  }

  /** Fire and forget: commands on one connection are sent in order, and Postgres already has the data. */
  publish(docId: string, msg: BusMessage): void {
    const env: Envelope = { from: this.selfId, msg };
    this.pub.publish(PREFIX + docId, JSON.stringify(env)).catch((err: unknown) => {
      console.error('redis publish failed:', err);
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
