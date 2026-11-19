import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const seeds = (process.env.SWEEP_SEEDS ?? '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);
const runs = Number(process.env.SWEEP_RUNS ?? 10_000);

interface SeedResult {
  seed: number;
  runsPerProperty: number;
  passed: boolean;
  seconds: number;
  failureOutput?: string;
}

const results: SeedResult[] = [];
for (const seed of seeds) {
  const t0 = Date.now();
  const r = spawnSync('npx', ['vitest', 'run', 'tests/property'], {
    env: { ...process.env, PBT_SEED: String(seed), PBT_RUNS: String(runs) },
    encoding: 'utf8',
  });
  const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const passed = r.status === 0;
  const result: SeedResult = { seed, runsPerProperty: runs, passed, seconds };
  if (!passed) result.failureOutput = `${r.stdout}\n${r.stderr}`.split('\n').slice(-80).join('\n');
  results.push(result);
  console.log(`seed ${seed}: ${passed ? 'PASS' : 'FAIL'} (${seconds}s, ${runs} runs per property)`);
  if (!passed) console.log(result.failureOutput);
}

const summary = {
  date: new Date().toISOString(),
  machine: `${os.cpus()[0]?.model ?? 'unknown'}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
  node: process.version,
  properties: 3,
  seeds: seeds.length,
  runsPerProperty: runs,
  totalHistories: seeds.length * runs * 3,
  allPassed: results.every((r) => r.passed),
  results,
};
mkdirSync('bench/results', { recursive: true });
writeFileSync('bench/results/property-sweep.json', `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `${summary.allPassed ? 'ALL PASSED' : 'FAILURES'}: ${summary.totalHistories} histories across ${seeds.length} seeds`,
);
process.exit(summary.allPassed ? 0 : 1);
