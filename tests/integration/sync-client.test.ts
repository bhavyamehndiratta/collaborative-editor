import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncClient } from '../../packages/client/src/sync-client.js';
import { loadConfig } from '../../packages/server/src/config.js';
import { startServer, type RunningServer } from '../../packages/server/src/server.js';

async function eventually(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('SyncClient against the real server', () => {
  let server: RunningServer;
  let url: string;
  beforeAll(async () => {
    server = await startServer(loadConfig({ ...process.env, PORT: '0' }));
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.close();
  });

  function ready(c: SyncClient): Promise<void> {
    return new Promise((resolve) => {
      c.onReady = resolve;
      c.start();
    });
  }

  it('syncs two clients, and merges edits made while one was disconnected', async () => {
    const res = await fetch(`${url}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sync-client' }),
    });
    const { id: docId } = (await res.json()) as { id: string };

    const a = new SyncClient({ serverUrl: url, docId, replicaId: 'ca' });
    const b = new SyncClient({ serverUrl: url, docId, replicaId: 'cb' });
    await Promise.all([ready(a), ready(b)]);

    a.applyLocal(0, 0, 'hello');
    await eventually(() => b.text() === 'hello');
    await eventually(() => a.status === 'online' && a.unackedCount === 0);

    a.dropConnection();
    await eventually(() => a.status === 'offline');
    a.applyLocal(5, 0, ' world');
    b.applyLocal(5, 0, '!');
    expect(a.status).toBe('offline');
    expect(a.unackedCount).toBe(6);

    await eventually(() => a.text() === b.text() && a.text().includes('world') && a.text().includes('!'));
    await eventually(() => a.status === 'online' && a.unackedCount === 0);
    expect(a.text()).toBe(b.text());
    a.stop();
    b.stop();
  });

  it('deletes propagate and a deleted range stays deleted', async () => {
    const res = await fetch(`${url}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sync-client-delete' }),
    });
    const { id: docId } = (await res.json()) as { id: string };
    const a = new SyncClient({ serverUrl: url, docId, replicaId: 'da' });
    const b = new SyncClient({ serverUrl: url, docId, replicaId: 'db' });
    await Promise.all([ready(a), ready(b)]);
    a.applyLocal(0, 0, 'abcdef');
    await eventually(() => b.text() === 'abcdef');
    b.applyLocal(1, 3, 'X');
    await eventually(() => a.text() === 'aXef');
    expect(b.text()).toBe('aXef');
    a.stop();
    b.stop();
  });
});
