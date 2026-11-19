import fs from 'node:fs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const microFile = fs
  .readdirSync('bench/results')
  .filter((f) => f.startsWith('crdt-micro-'))
  .sort()
  .at(-1);
if (microFile === undefined) throw new Error('no crdt-micro results found');
const micro = readJson(`bench/results/${microFile}`);
const sweep = readJson('bench/results/property-sweep.json');
const load = readJson('bench/results/load-test.json');

const n = (x) => x.toLocaleString('en-US');
const f2 = (x) => x.toFixed(2);
const triple = (m) => `${f2(m.p50)} / ${f2(m.p95)} / ${f2(m.p99)}`;

const r = micro.results;
const h = micro.hardware;
const out = [];

out.push('### Hardware', '');
out.push(
  `${h.cpu}, ${h.cores} cores, ${h.memoryGB} GB RAM, ${h.platform}, Node ${h.node}. In the load test the two server processes, the load generator, Redis and PostgreSQL all ran on this one machine.`,
  '',
);

out.push(`### CRDT micro benchmarks (${n(micro.n)} characters, default block size)`, '');
out.push('| Operation | Time per operation |', '| --- | --- |');
const micros = [
  ['Local append (insert at the end)', r.local_append_us_per_op],
  ['Local insert at a random position', r.local_random_insert_us_per_op],
  ['Local delete at a random position', r.local_random_delete_us_per_op],
  ['Remote apply, causal order', r.remote_apply_in_order_us_per_op],
  ['Remote apply, reverse delivery order', r.remote_apply_reverse_us_per_op],
];
for (const [name, us] of micros) out.push(`| ${name} | ${f2(us)} us |`);
out.push('');
out.push(
  `Reading the full text takes ${f2(r.text_read_total_ms)} ms. Memory is ${f2(r.bytes_per_char_random_insert)} bytes of heap per character with random inserts (every character is its own node). Compacting after ${n(r.tombstones_before_compact)} deletes removed ${n(r.nodes_removed_by_compact)} of ${n(r.nodes_before_compact)} nodes in ${f2(r.compact_ms)} ms.`,
  '',
);

out.push('### Convergence testing', '');
out.push(
  sweep.allPassed
    ? `${n(sweep.totalHistories)} generated histories passed (${sweep.properties} properties, ${sweep.seeds} seeds, ${n(sweep.runsPerProperty)} runs per property per seed). Each history is up to 80 commands across several replicas with reordered, duplicated and delayed delivery and replicas going offline. Seeds: ${sweep.results.map((x) => x.seed).join(', ')}.`
    : `The sweep reported failures. See bench/results/property-sweep.json.`,
  '',
);

out.push('### Load test (2 server instances, Redis fan-out, PostgreSQL)', '');
out.push(
  `Every editor types ${load.latency[0].opsPerEditorPerSecond} operations per second for ${load.latency[0].seconds} seconds after a 3 second warmup. Editors alternate between the two instances. Latency is the time from an editor sending an operation to another editor's socket receiving it, in milliseconds (p50 / p95 / p99).`,
  '',
);
out.push(
  '| Editors | Deliveries per second | Same instance | Across instances (via Redis) | Errors |',
  '| --- | --- | --- | --- | --- |',
);
for (const s of load.latency) {
  out.push(
    `| ${s.editors} | ${n(Math.round(s.deliveriesPerSecond))} | ${triple(s.sameInstanceMs)} | ${triple(s.crossInstanceMs)} | ${s.errors} |`,
  );
}
out.push('');
const lagMax = Math.max(...load.latency.map((s) => s.generatorLoopLagP99Ms));
const last = load.latency.at(-1);
out.push(
  `About 10 ms of every figure is the server's deliberate 10 ms outbound batching window. The load generator's own event loop delay p99 stayed at or below ${f2(lagMax)} ms (the sampling resolution is 10 ms, so that is close to idle). Server memory after the ${last.editors} editor run was ${last.serverRssMb.map((x) => `${f2(x)} MB`).join(' and ')} resident.`,
  '',
);
out.push(
  `Write throughput: ${load.write.writers} writers on separate documents, ${n(load.write.opsPerWriter)} operations each in batches of ${load.write.batchSize}, waiting for the server's ack after every batch, persisted ${n(load.write.persistedOpsPerSecond)} operations per second (${n(load.write.totalOps)} operations in ${load.write.seconds} s, including snapshots). This is a short single run.`,
  '',
);
out.push(
  'Limits of these numbers: one machine, synthetic append style edits rather than real typing patterns, and no network latency between clients and servers. They show how the server behaves under fan-out load, not what a deployed system would measure.',
);

function fill(doc, name, content) {
  const re = new RegExp(`<!-- ${name}:START -->[\\s\\S]*?<!-- ${name}:END -->`);
  if (!re.test(doc)) throw new Error(`marker ${name} missing in README.md`);
  return doc.replace(re, () => `<!-- ${name}:START -->\n${content}\n<!-- ${name}:END -->`);
}

let readme = fs.readFileSync('README.md', 'utf8');
readme = fill(readme, 'RESULTS', out.join('\n'));
readme = fill(
  readme,
  'DEMO',
  fs.existsSync('docs/demo.gif')
    ? '![Two browser windows editing the same document, with remote cursors](docs/demo.gif)'
    : '',
);
fs.writeFileSync('README.md', readme);
console.log('README.md updated');
