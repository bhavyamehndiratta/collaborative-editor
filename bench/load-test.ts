import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

const EDITORS = (process.env.LOAD_EDITORS ?? '10,50,100,200').split(',').map(Number);
const RATE = Number(process.env.LOAD_RATE ?? 2);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 20);
const WARMUP_MS = 3000;
const WRITERS = Number(process.env.LOAD_WRITERS ?? 8);
const WRITE_OPS = Number(process.env.LOAD_WRITE_OPS ?? 20_000);
const BATCH = 500;
const ROOT = { replica: '', counter: 0 };

interface Id {
  replica: string;
  counter: number;
}

interface ServerMsg {
  type: string;
  ops?: Array<{ type: string; id: Id }>;
  version?: Record<string, number>;
  message?: string;
}

interface Instance {
  id: string;
  port: number;
  proc: ChildProcess;
}

interface Editor {
  ws: WebSocket;
  docId: string;
  replica: string;
  instance: number;
  counter: number;
  lastId: Id;
  ready: boolean;
  waitFor: { counter: number; resolve: () => void } | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const round = (n: number): number => Math.round(n * 100) / 100;

function startInstance(id: string, port: number): Promise<Instance> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['packages/server/dist/main.js'], {
      env: { ...process.env, PORT: String(port), INSTANCE_ID: id },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => reject(new Error(`${id} did not start`)), 15_000);
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve({ id, port, proc });
      }
    });
    proc.once('exit', (code) => reject(new Error(`${id} exited early with code ${code}`)));
  });
}

async function stopInstance(inst: Instance): Promise<void> {
  const done = new Promise<void>((resolve) => inst.proc.once('exit', () => resolve()));
  inst.proc.kill('SIGTERM');
  await done;
}

function rssMb(inst: Instance): number {
  const pid = inst.proc.pid;
  if (pid === undefined) return Number.NaN;
  const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  return round(Number(out.trim()) / 1024);
}

async function createDoc(inst: Instance, name: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { id: string }).id;
}

function openEditor(
  inst: Instance,
  instance: number,
  docId: string,
  replica: string,
  onMessage: (ed: Editor, msg: ServerMsg) => void,
): Promise<Editor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/ws`);
    const ed: Editor = {
      ws,
      docId,
      replica,
      instance,
      counter: 0,
      lastId: ROOT,
      ready: false,
      waitFor: undefined,
    };
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', docId, replicaId: replica, version: {} })),
    );
    ws.on('message', (data) => {
      const msg = JSON.parse((data as Buffer).toString('utf8')) as ServerMsg;
      if (!ed.ready && msg.type === 'snapshot') {
        ed.ready = true;
        resolve(ed);
        return;
      }
      onMessage(ed, msg);
    });
    ws.on('error', reject);
  });
}

function nextInsert(ed: Editor): { type: 'insert'; id: Id; parent: Id; side: 'R'; value: string } {
  ed.counter++;
  const id = { replica: ed.replica, counter: ed.counter };
  const op = { type: 'insert' as const, id, parent: ed.lastId, side: 'R' as const, value: 'x' };
  ed.lastId = id;
  return op;
}

function summarize(values: number[]): { count: number; p50: number; p95: number; p99: number } {
  const sorted = Float64Array.from(values).sort();
  const at = (p: number): number =>
    sorted.length === 0
      ? Number.NaN
      : round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN);
  return { count: sorted.length, p50: at(50), p95: at(95), p99: at(99) };
}

async function latencyScenario(insts: readonly [Instance, Instance], editors: number) {
  const docId = await createDoc(insts[0], `load-${editors}-editors`);
  const same: number[] = [];
  const cross: number[] = [];
  const sentAt = new Map<string, number>();
  const instanceOf = new Map<string, number>();
  let measuring = false;
  let sentInWindow = 0;
  let errors = 0;

  const onMessage = (ed: Editor, msg: ServerMsg): void => {
    if (msg.type === 'ops' && msg.ops !== undefined) {
      const now = performance.now();
      for (const op of msg.ops) {
        const t = sentAt.get(`${op.id.replica}:${op.id.counter}`);
        if (t === undefined || !measuring) continue;
        (instanceOf.get(op.id.replica) === ed.instance ? same : cross).push(now - t);
      }
    } else if (msg.type === 'error') {
      errors++;
    }
  };

  const eds: Editor[] = [];
  for (let i = 0; i < editors; i++) {
    const instance = i % 2;
    const inst = instance === 0 ? insts[0] : insts[1];
    const replica = `ld-${i}`;
    instanceOf.set(replica, instance);
    eds.push(await openEditor(inst, instance, docId, replica, onMessage));
  }

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const timers: NodeJS.Timeout[] = [];
  for (const ed of eds) {
    const start = setTimeout(
      () => {
        timers.push(
          setInterval(() => {
            const op = nextInsert(ed);
            sentAt.set(`${ed.replica}:${op.id.counter}`, performance.now());
            if (measuring) sentInWindow++;
            ed.ws.send(JSON.stringify({ type: 'ops', docId, ops: [op] }));
          }, 1000 / RATE),
        );
      },
      Math.random() * (1000 / RATE),
    );
    timers.push(start);
  }

  await sleep(WARMUP_MS);
  measuring = true;
  const t0 = performance.now();
  await sleep(SECONDS * 1000);
  measuring = false;
  const elapsed = (performance.now() - t0) / 1000;
  for (const t of timers) clearInterval(t);
  const rss = [rssMb(insts[0]), rssMb(insts[1])];
  await sleep(1000);
  lag.disable();
  for (const ed of eds) ed.ws.close();

  return {
    editors,
    opsPerEditorPerSecond: RATE,
    seconds: SECONDS,
    sentOpsPerSecond: round(sentInWindow / elapsed),
    deliveriesPerSecond: round((same.length + cross.length) / elapsed),
    sameInstanceMs: summarize(same),
    crossInstanceMs: summarize(cross),
    errors,
    generatorLoopLagP99Ms: round(lag.percentile(99) / 1e6),
    serverRssMb: rss,
  };
}

async function writeThroughput(insts: readonly [Instance, Instance]) {
  const onMessage = (ed: Editor, msg: ServerMsg): void => {
    if (msg.type !== 'ack' || ed.waitFor === undefined) return;
    if ((msg.version?.[ed.replica] ?? 0) >= ed.waitFor.counter) {
      const { resolve } = ed.waitFor;
      ed.waitFor = undefined;
      resolve();
    }
  };
  const eds: Editor[] = [];
  for (let i = 0; i < WRITERS; i++) {
    const instance = i % 2;
    const inst = instance === 0 ? insts[0] : insts[1];
    const docId = await createDoc(inst, `load-write-${i}`);
    eds.push(await openEditor(inst, instance, docId, `wr-${i}`, onMessage));
  }
  const writeAll = async (ed: Editor): Promise<void> => {
    for (let done = 0; done < WRITE_OPS; done += BATCH) {
      const n = Math.min(BATCH, WRITE_OPS - done);
      const ops = Array.from({ length: n }, () => nextInsert(ed));
      const target = ed.counter;
      await new Promise<void>((resolve) => {
        ed.waitFor = { counter: target, resolve };
        ed.ws.send(JSON.stringify({ type: 'ops', docId: ed.docId, ops }));
      });
    }
  };
  const t0 = performance.now();
  await Promise.all(eds.map(writeAll));
  const seconds = (performance.now() - t0) / 1000;
  for (const ed of eds) ed.ws.close();
  const totalOps = WRITERS * WRITE_OPS;
  return {
    writers: WRITERS,
    opsPerWriter: WRITE_OPS,
    batchSize: BATCH,
    totalOps,
    seconds: round(seconds),
    persistedOpsPerSecond: Math.round(totalOps / seconds),
  };
}

async function main(): Promise<void> {
  const s1 = await startInstance('load-1', 18081);
  const s2 = await startInstance('load-2', 18082);
  const insts = [s1, s2] as const;
  try {
    const latency = [];
    for (const editors of EDITORS) {
      console.log(`latency scenario: ${editors} editors, ${RATE} ops/s each, ${SECONDS}s`);
      const r = await latencyScenario(insts, editors);
      latency.push(r);
      console.log(
        `  same p50/p95/p99 ${r.sameInstanceMs.p50}/${r.sameInstanceMs.p95}/${r.sameInstanceMs.p99} ms, ` +
          `cross ${r.crossInstanceMs.p50}/${r.crossInstanceMs.p95}/${r.crossInstanceMs.p99} ms, ` +
          `${r.deliveriesPerSecond} deliveries/s, errors ${r.errors}, generator lag p99 ${r.generatorLoopLagP99Ms} ms`,
      );
    }
    console.log(`write throughput: ${WRITERS} writers x ${WRITE_OPS} ops`);
    const write = await writeThroughput(insts);
    console.log(`  ${write.persistedOpsPerSecond} persisted ops/s over ${write.seconds}s`);

    const summary = {
      date: new Date().toISOString(),
      machine: `${os.cpus()[0]?.model ?? 'unknown'}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
      node: process.version,
      topology: '2 server processes, 1 Redis, 1 PostgreSQL, all on this machine',
      latency,
      write,
    };
    mkdirSync('bench/results', { recursive: true });
    writeFileSync('bench/results/load-test.json', `${JSON.stringify(summary, null, 2)}\n`);
    console.log('saved bench/results/load-test.json');
  } finally {
    await stopInstance(s1);
    await stopInstance(s2);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
