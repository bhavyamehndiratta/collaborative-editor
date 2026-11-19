import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncClient } from '../../packages/client/src/sync-client.js';
import { loadConfig } from '../../packages/server/src/config.js';
import { startServer, type RunningServer } from '../../packages/server/src/server.js';

async function eventually(fn: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function boot(instanceId: string): Promise<RunningServer> {
  return startServer(
    loadConfig({ ...process.env, PORT: '0', INSTANCE_ID: instanceId, SNAPSHOT_EVERY: '3' }),
  );
}

const urlOf = (s: RunningServer): string => `http://127.0.0.1:${s.port}`;

async function createDoc(url: string, name: string): Promise<string> {
  const res = await fetch(`${url}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function connect(url: string, docId: string, replicaId: string): Promise<SyncClient> {
  const c = new SyncClient({ serverUrl: url, docId, replicaId, name: replicaId, color: '#005cc5' });
  await new Promise<void>((resolve) => {
    c.onReady = resolve;
    c.start();
  });
  return c;
}

describe('two server instances sharing Redis and Postgres', () => {
  let s1: RunningServer;
  let s2: RunningServer;
  beforeAll(async () => {
    s1 = await boot('s1');
    s2 = await boot('s2');
  });
  afterAll(async () => {
    await s1.close();
    await s2.close();
  });

  it('delivers edits between clients on different instances, in both directions', async () => {
    const docId = await createDoc(urlOf(s1), 'mi-basic');
    const a = await connect(urlOf(s1), docId, 'mi-a');
    const b = await connect(urlOf(s2), docId, 'mi-b');
    a.applyLocal(0, 0, 'hello');
    await eventually(() => b.text() === 'hello');
    b.applyLocal(5, 0, ' world');
    await eventually(() => a.text() === 'hello world');
    a.stop();
    b.stop();
  });

  it('shares presence across instances, including with a late joiner', async () => {
    const docId = await createDoc(urlOf(s1), 'mi-presence');
    const a = await connect(urlOf(s1), docId, 'pr-a');
    const b = await connect(urlOf(s2), docId, 'pr-b');
    a.setLocalCursor(0, 0);
    await eventually(() => b.remote.get('pr-a') !== undefined);
    const c = await connect(urlOf(s2), docId, 'pr-c');
    await eventually(() => c.remote.get('pr-a') !== undefined);
    a.stop();
    await eventually(() => !b.remote.has('pr-a') && !c.remote.has('pr-a'));
    b.stop();
    c.stop();
  });

  it('converges under concurrent edits on both instances, and a fresh instance recovers the same text', async () => {
    const docId = await createDoc(urlOf(s1), 'mi-recover');
    const a = await connect(urlOf(s1), docId, 'rc-a');
    const b = await connect(urlOf(s2), docId, 'rc-b');
    for (let i = 0; i < 30; i++) {
      a.applyLocal(0, 0, 'a');
      b.applyLocal(b.text().length, 0, 'b');
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 5));
    }
    await eventually(
      () =>
        a.text() === b.text() &&
        a.text().length === 60 &&
        a.unackedCount === 0 &&
        b.unackedCount === 0,
    );
    const final = a.text();
    a.stop();
    b.stop();

    // Snapshots were written by both instances with interleaved seqs. A third instance that
    // loads snapshot plus log must still see every operation.
    const s3 = await boot('s3');
    try {
      const c = await connect(urlOf(s3), docId, 'rc-c');
      expect(c.text()).toBe(final);
      c.stop();
    } finally {
      await s3.close();
    }
  });
});
