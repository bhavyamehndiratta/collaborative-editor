import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CrdtDocument, idKey, type Id, type Operation } from '../../packages/crdt/src/index.js';

const NUM_RUNS = Number(process.env.PBT_RUNS ?? 1000);
const SEED = process.env.PBT_SEED === undefined ? undefined : Number(process.env.PBT_SEED);
const PARAMS = { numRuns: NUM_RUNS, ...(SEED === undefined ? {} : { seed: SEED }) };
const TIMEOUT_MS = 900_000;

// ---------------------------------------------------------------------------
// Simulated cluster: peers, a lossless but reorderable and duplicating network,
// offline periods, and a test-side causal buffer (the library buffer comes in Stage 5).
// ---------------------------------------------------------------------------

interface Peer {
  doc: CrdtDocument;
  pending: Operation[];
  inbox: Operation[];
  outbox: Operation[];
  online: boolean;
}

interface Intent {
  id: Id;
  left: Id | undefined;
  right: Id | undefined;
}

function makePeer(replicaId: string): Peer {
  return { doc: new CrdtDocument(replicaId, { blockSize: 4 }), pending: [], inbox: [], outbox: [], online: true };
}

function receive(peer: Peer, op: Operation): void {
  peer.doc.receive(op);
}

type Cmd =
  | { k: 'insert'; r: number; at: number; ch: string }
  | { k: 'delete'; r: number; at: number }
  | { k: 'deliver'; r: number; pick: number }
  | { k: 'dup'; r: number; pick: number }
  | { k: 'offline'; r: number }
  | { k: 'online'; r: number };

const letter = fc.constantFrom(...'abcdefghij'.split(''));
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant('insert' as const),
      r: fc.nat(3),
      at: fc.nat(1000),
      ch: letter,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ k: fc.constant('delete' as const), r: fc.nat(3), at: fc.nat(1000) }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ k: fc.constant('deliver' as const), r: fc.nat(3), pick: fc.nat(1000) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('dup' as const), r: fc.nat(3), pick: fc.nat(1000) }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('offline' as const), r: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('online' as const), r: fc.nat(3) }) },
);

function runHistory(count: number, cmds: Cmd[]) {
  const peers: Peer[] = Array.from({ length: count }, (_, i) => makePeer(`r${i}`));
  const allOps: Operation[] = [];
  const intents: Intent[] = [];
  const peerAt = (i: number): Peer => {
    const p = peers[i % count];
    if (p === undefined) throw new Error('no such peer');
    return p;
  };
  const flush = (peer: Peer): void => {
    for (const op of peer.outbox) for (const o of peers) if (o !== peer) o.inbox.push(op);
    peer.outbox = [];
  };
  const broadcast = (peer: Peer, op: Operation): void => {
    allOps.push(op);
    if (peer.online) {
      for (const o of peers) if (o !== peer) o.inbox.push(op);
    } else {
      peer.outbox.push(op);
    }
  };

  for (const cmd of cmds) {
    const peer = peerAt(cmd.r);
    switch (cmd.k) {
      case 'insert': {
        const vis = peer.doc.visibleIds();
        const at = cmd.at % (vis.length + 1);
        const left = at > 0 ? vis[at - 1] : undefined;
        const right = at < vis.length ? vis[at] : undefined;
        const op = peer.doc.insert(at, cmd.ch);
        intents.push({ id: op.id, left, right });
        broadcast(peer, op);
        break;
      }
      case 'delete': {
        if (peer.doc.length === 0) break;
        broadcast(peer, peer.doc.delete(cmd.at % peer.doc.length));
        break;
      }
      case 'deliver': {
        if (!peer.online || peer.inbox.length === 0) break;
        const [op] = peer.inbox.splice(cmd.pick % peer.inbox.length, 1);
        if (op !== undefined) receive(peer, op);
        break;
      }
      case 'dup': {
        if (peer.inbox.length === 0) break;
        const op = peer.inbox[cmd.pick % peer.inbox.length];
        if (op !== undefined) peer.inbox.push(op);
        break;
      }
      case 'offline':
        peer.online = false;
        break;
      case 'online':
        peer.online = true;
        flush(peer);
        break;
    }
  }

  for (const peer of peers) {
    peer.online = true;
    flush(peer);
  }
  for (const peer of peers) {
    while (peer.inbox.length > 0) {
      const op = peer.inbox.shift();
      if (op !== undefined) receive(peer, op);
    }
  }
  return { peers, allOps, intents };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

function replayInto(ops: Operation[]): CrdtDocument {
  const peer = makePeer('checker');
  for (const op of ops) receive(peer, op);
  expect(peer.doc.bufferedCount).toBe(0);
  return peer.doc;
}

const keys = (ids: Id[]): string[] => ids.map(idKey);

describe('property: convergence under random concurrent histories', () => {
  it(
    'converges, is idempotent, commutative, and preserves intention',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            count: fc.integer({ min: 2, max: 4 }),
            cmds: fc.array(cmdArb, { minLength: 1, maxLength: 80 }),
            shuffleSeed: fc.integer(),
          }),
          ({ count, cmds, shuffleSeed }) => {
            const { peers, allOps, intents } = runHistory(count, cmds);
            const first = peers[0];
            if (first === undefined) throw new Error('no peers');

            // Strong eventual consistency: same text and same element order everywhere.
            for (const peer of peers) {
              expect(peer.doc.bufferedCount).toBe(0);
              expect(peer.doc.text()).toBe(first.doc.text());
              expect(peer.doc.version().toJSON()).toEqual(first.doc.version().toJSON());
              expect(peer.doc.verifyStructure()).toBe(true);
              expect(keys(peer.doc.orderedIds())).toEqual(keys(first.doc.orderedIds()));
            }

            // Intention preservation: every insert stays between the neighbours it had
            // at the moment the user typed it.
            const pos = new Map(keys(first.doc.orderedIds()).map((k, i) => [k, i] as const));
            for (const it of intents) {
              const p = pos.get(idKey(it.id));
              expect(p).toBeDefined();
              if (p === undefined) continue;
              if (it.left !== undefined) expect(pos.get(idKey(it.left)) ?? Infinity).toBeLessThan(p);
              if (it.right !== undefined) expect(pos.get(idKey(it.right)) ?? -Infinity).toBeGreaterThan(p);
            }

            // Idempotence: replaying the whole log into every replica changes nothing.
            for (const peer of peers) {
              const before = peer.doc.text();
              for (const op of allOps) receive(peer, op);
              expect(peer.doc.text()).toBe(before);
              expect(peer.doc.bufferedCount).toBe(0);
            }

            // Commutativity: any delivery order of the full log gives the same result.
            const expected = first.doc.text();
            expect(replayInto(shuffled(allOps, shuffleSeed)).text()).toBe(expected);
            expect(replayInto(allOps.slice().reverse()).text()).toBe(expected);
          },
        ),
        PARAMS,
      );
    },
    TIMEOUT_MS,
  );
});

describe('property: non-interleaving of concurrent runs', () => {
  it(
    'keeps each user run contiguous when two users type at the same spot',
    () => {
      const digits = fc.constantFrom(...'0123456789'.split(''));
      const lower = fc.constantFrom(...'abcdefghij'.split(''));
      const upper = fc.constantFrom(...'ABCDEFGHIJ'.split(''));
      fc.assert(
        fc.property(
          fc.record({
            base: fc.array(digits, { maxLength: 6 }).map((a) => a.join('')),
            textA: fc.array(lower, { minLength: 1, maxLength: 8 }).map((a) => a.join('')),
            textB: fc.array(upper, { minLength: 1, maxLength: 8 }).map((a) => a.join('')),
            idxA: fc.nat(100),
            idxB: fc.nat(100),
            sameSpot: fc.boolean(),
            backA: fc.boolean(),
            backB: fc.boolean(),
          }),
          (c) => {
            const a = new CrdtDocument('a');
            const b = new CrdtDocument('b');
            const baseOps = [...c.base].map((ch, i) => a.insert(i, ch));
            for (const op of baseOps) b.apply(op);

            const ia = c.idxA % (c.base.length + 1);
            const ib = c.sameSpot ? ia : c.idxB % (c.base.length + 1);
            const type = (d: CrdtDocument, text: string, at: number, back: boolean): Operation[] =>
              back
                ? [...text].reverse().map((ch) => d.insert(at, ch))
                : [...text].map((ch, i) => d.insert(at + i, ch));
            const opsA = type(a, c.textA, ia, c.backA);
            const opsB = type(b, c.textB, ib, c.backB);

            const x = replayInto([...baseOps, ...opsA, ...opsB]);
            const y = replayInto([...baseOps, ...opsB, ...opsA]);
            expect(x.text()).toBe(y.text());
            expect(x.text()).toContain(c.textA);
            expect(x.text()).toContain(c.textB);
          },
        ),
        PARAMS,
      );
    },
    TIMEOUT_MS,
  );
});

describe('property: tombstone compaction', () => {
  it(
    'keeps text and order on converged replicas, and editing still converges afterwards',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            count: fc.integer({ min: 2, max: 4 }),
            cmds: fc.array(cmdArb, { minLength: 1, maxLength: 80 }),
          }),
          ({ count, cmds }) => {
            const { peers } = runHistory(count, cmds);
            const first = peers[0];
            if (first === undefined) throw new Error('no peers');
            const textBefore = first.doc.text();

            const removed = peers.map((p) => p.doc.compact(p.doc.version()));
            for (const r of removed) expect(r).toBe(removed[0]);
            for (const peer of peers) {
              expect(peer.doc.text()).toBe(textBefore);
              expect(peer.doc.verifyStructure()).toBe(true);
              expect(keys(peer.doc.orderedIds())).toEqual(keys(first.doc.orderedIds()));
            }

            const more: Operation[] = [];
            for (const peer of peers) {
              more.push(peer.doc.insert(0, 'z'));
              if (peer.doc.length > 1) more.push(peer.doc.delete(peer.doc.length - 1));
            }
            for (const peer of peers) for (const op of more) peer.doc.receive(op);
            for (const peer of peers) {
              expect(peer.doc.bufferedCount).toBe(0);
              expect(peer.doc.text()).toBe(first.doc.text());
              expect(keys(peer.doc.orderedIds())).toEqual(keys(first.doc.orderedIds()));
            }
          },
        ),
        PARAMS,
      );
    },
    TIMEOUT_MS,
  );
});
