import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import vm from 'node:vm';
import { CrdtDocument, type Operation } from '../packages/crdt/src/index.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const N = Number(process.env.BENCH_N ?? 100_000);
const BLOCK = process.env.BENCH_BLOCK === undefined ? undefined : Number(process.env.BENCH_BLOCK);

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

function makeDoc(id: string): CrdtDocument {
  return new CrdtDocument(id, BLOCK === undefined ? {} : { blockSize: BLOCK });
}

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function heapUsed(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;
const results: Record<string, number> = {};
function record(name: string, ms: number, ops: number): void {
  results[`${name}_total_ms`] = round(ms);
  results[`${name}_us_per_op`] = round((ms * 1000) / ops);
}

const rand = mulberry32(42);

// Local sequential typing (append).
const docA = makeDoc('a');
const opsA: Operation[] = [];
record('local_append', time(() => { for (let i = 0; i < N; i++) opsA.push(docA.insert(i, 'x')); }), N);

// Local random inserts.
const docB = makeDoc('b');
const opsB: Operation[] = [];
record(
  'local_random_insert',
  time(() => { for (let i = 0; i < N; i++) opsB.push(docB.insert(Math.floor(rand() * (i + 1)), 'x')); }),
  N,
);

// Remote apply, in order (random-insert history).
const replayB = makeDoc('r1');
record('remote_apply_in_order', time(() => { for (const op of opsB) replayB.receive(op); }), N);

// Remote apply, fully reversed (every op buffered until the first arrives).
const replayRev = makeDoc('r2');
record(
  'remote_apply_reverse',
  time(() => { for (let i = opsA.length - 1; i >= 0; i--) replayRev.receive(opsA[i] as Operation); }),
  N,
);

if (replayB.text() !== docB.text()) throw new Error('replay in order diverged');
if (replayRev.text() !== docA.text()) throw new Error('replay reverse diverged');

record('text_read', time(() => { docB.text(); }), 1);

// Memory per character (random-insert document).
const heapBefore = heapUsed();
const memDoc = makeDoc('m');
for (let i = 0; i < N; i++) memDoc.insert(Math.floor(rand() * (i + 1)), 'x');
const heapAfter = heapUsed();
results['bytes_per_char_random_insert'] = round((heapAfter - heapBefore) / N);

// Delete half at random, then compact.
const deletes = Math.floor(N / 2);
record('local_random_delete', time(() => { for (let i = 0; i < deletes; i++) memDoc.delete(Math.floor(rand() * memDoc.length)); }), deletes);
results['nodes_before_compact'] = memDoc.nodeCount;
results['tombstones_before_compact'] = memDoc.tombstoneCount;
const heapBeforeCompact = heapUsed();
let removed = 0;
const compactMs = time(() => { removed = memDoc.compact(memDoc.version()); });
const heapAfterCompact = heapUsed();
results['compact_ms'] = round(compactMs);
results['nodes_removed_by_compact'] = removed;
results['nodes_after_compact'] = memDoc.nodeCount;
results['heap_bytes_before_compact'] = heapBeforeCompact;
results['heap_bytes_after_compact'] = heapAfterCompact;

const cpus = os.cpus();
const report = {
  when: new Date().toISOString(),
  n: N,
  blockSize: BLOCK ?? 'default (512)',
  hardware: {
    cpu: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    memoryGB: round(os.totalmem() / 1024 ** 3),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  },
  results,
};
console.log(JSON.stringify(report, null, 2));
const file = `bench/results/crdt-micro-${report.when.replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(`saved ${file}`);
