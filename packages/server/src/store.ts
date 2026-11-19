import { randomUUID } from 'node:crypto';
import type { DocumentSnapshot, Operation } from '@collab/crdt';
import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations (
  seq bigserial NOT NULL,
  doc_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  replica_id text NOT NULL,
  counter integer NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, replica_id, counter)
);
CREATE INDEX IF NOT EXISTS operations_doc_seq ON operations (doc_id, seq);
CREATE TABLE IF NOT EXISTS snapshots (
  doc_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  last_seq bigint NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export interface DocInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

type DocRow = { id: string; name: string; created_at: Date };
type InsertedRow = { replica_id: string; counter: number; seq: string };

export class Store {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    this.pool.on('error', (err) => console.error('postgres pool error', err));
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createDoc(name: string): Promise<DocInfo> {
    const id = randomUUID();
    const res = await this.pool.query<DocRow>(
      'INSERT INTO documents (id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [id, name],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error('insert returned no row');
    return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
  }

  async listDocs(): Promise<DocInfo[]> {
    const res = await this.pool.query<DocRow>(
      'SELECT id, name, created_at FROM documents ORDER BY created_at DESC LIMIT 200',
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString() }));
  }

  async docExists(docId: string): Promise<boolean> {
    const res = await this.pool.query('SELECT 1 FROM documents WHERE id = $1', [docId]);
    return res.rowCount !== null && res.rowCount > 0;
  }

  /** Persists operations idempotently. Returns only the ones that were new, and the highest seq. */
  async appendOps(
    docId: string,
    ops: Operation[],
  ): Promise<{ inserted: Operation[]; maxSeq: number }> {
    const res = await this.pool.query<InsertedRow>(
      `INSERT INTO operations (doc_id, replica_id, counter, payload)
       SELECT $1::uuid, t.r, t.c, t.p::jsonb
       FROM unnest($2::text[], $3::int[], $4::text[]) AS t(r, c, p)
       ON CONFLICT DO NOTHING
       RETURNING replica_id, counter, seq`,
      [
        docId,
        ops.map((o) => o.id.replica),
        ops.map((o) => o.id.counter),
        ops.map((o) => JSON.stringify(o)),
      ],
    );
    const fresh = new Set(res.rows.map((r) => `${r.replica_id}:${r.counter}`));
    const inserted: Operation[] = [];
    for (const op of ops) {
      const key = `${op.id.replica}:${op.id.counter}`;
      if (fresh.delete(key)) inserted.push(op);
    }
    let maxSeq = 0;
    for (const r of res.rows) maxSeq = Math.max(maxSeq, Number(r.seq));
    return { inserted, maxSeq };
  }

  async loadSnapshot(
    docId: string,
  ): Promise<{ lastSeq: number; state: DocumentSnapshot } | undefined> {
    const res = await this.pool.query<{ last_seq: string; state: DocumentSnapshot }>(
      'SELECT last_seq, state FROM snapshots WHERE doc_id = $1',
      [docId],
    );
    const row = res.rows[0];
    if (row === undefined) return undefined;
    return { lastSeq: Number(row.last_seq), state: row.state };
  }

  async saveSnapshot(docId: string, lastSeq: number, state: DocumentSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (doc_id, last_seq, state) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (doc_id) DO UPDATE
       SET last_seq = EXCLUDED.last_seq, state = EXCLUDED.state, created_at = now()`,
      [docId, lastSeq, JSON.stringify(state)],
    );
  }

  /** Streams the operation log after `afterSeq` in pages, in seq order. */
  async forEachOpAfter(
    docId: string,
    afterSeq: number,
    fn: (ops: Operation[], maxSeq: number) => void,
  ): Promise<void> {
    let cursor = afterSeq;
    for (;;) {
      const res = await this.pool.query<{ seq: string; payload: Operation }>(
        'SELECT seq, payload FROM operations WHERE doc_id = $1 AND seq > $2 ORDER BY seq LIMIT 5000',
        [docId, cursor],
      );
      const last = res.rows[res.rows.length - 1];
      if (last === undefined) return;
      cursor = Number(last.seq);
      fn(
        res.rows.map((r) => r.payload),
        cursor,
      );
    }
  }

  /**
   * Streams logged operations that a version vector does not cover, in pages ordered by seq.
   * Recovery and Redis resync use this instead of a seq cursor: with several writers, seq order
   * is not commit order, so "everything after last_seq" can silently skip an operation.
   */
  async forEachOpNotCovered(
    docId: string,
    covered: Record<string, number>,
    fn: (ops: Operation[], maxSeq: number) => void,
  ): Promise<void> {
    const vv = JSON.stringify(covered);
    let cursor = 0;
    for (;;) {
      const res = await this.pool.query<{ seq: string; payload: Operation }>(
        `SELECT seq, payload FROM operations
         WHERE doc_id = $1 AND seq > $2
           AND counter > COALESCE(($3::jsonb ->> replica_id)::int, 0)
         ORDER BY seq LIMIT 5000`,
        [docId, cursor, vv],
      );
      const last = res.rows[res.rows.length - 1];
      if (last === undefined) return;
      cursor = Number(last.seq);
      fn(
        res.rows.map((r) => r.payload),
        cursor,
      );
    }
  }

  /** Operations of one replica with after < counter <= upTo, in counter order. */
  async opsSince(
    docId: string,
    replicaId: string,
    after: number,
    upTo: number,
  ): Promise<Operation[]> {
    const res = await this.pool.query<{ payload: Operation }>(
      `SELECT payload FROM operations
       WHERE doc_id = $1 AND replica_id = $2 AND counter > $3 AND counter <= $4
       ORDER BY counter`,
      [docId, replicaId, after, upTo],
    );
    return res.rows.map((r) => r.payload);
  }
}
