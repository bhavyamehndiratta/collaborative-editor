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

describe('presence through the real server', () => {
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

  it('shares cursors anchored to elements, and removes them when a user leaves', async () => {
    const res = await fetch(`${url}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'presence' }),
    });
    const { id: docId } = (await res.json()) as { id: string };
    const a = new SyncClient({ serverUrl: url, docId, replicaId: 'pa', name: 'Ann', color: '#d73a49' });
    const b = new SyncClient({ serverUrl: url, docId, replicaId: 'pb', name: 'Bob', color: '#005cc5' });
    await Promise.all([ready(a), ready(b)]);

    a.applyLocal(0, 0, 'hello');
    await eventually(() => b.text() === 'hello');

    b.setLocalCursor(5, 5);
    await eventually(() => a.remote.get('pb')?.cursor != null);
    const seen = a.remote.get('pb');
    expect(seen?.name).toBe('Bob');
    expect(seen?.color).toBe('#005cc5');
    const head = seen?.cursor?.head;
    if (head === undefined) throw new Error('no cursor');
    expect(a.resolve(head)).toBe(5);

    a.applyLocal(0, 0, 'XX');
    expect(a.resolve(head)).toBe(7);
    await eventually(() => b.text() === 'XXhello');
    expect(b.resolve(head)).toBe(7);

    b.stop();
    await eventually(() => !a.remote.has('pb'));
    a.stop();
  });

  it('shows existing presence to a client that joins later', async () => {
    const res = await fetch(`${url}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'presence-late' }),
    });
    const { id: docId } = (await res.json()) as { id: string };
    const a = new SyncClient({ serverUrl: url, docId, replicaId: 'la', name: 'Early', color: '#22863a' });
    await ready(a);
    a.setLocalCursor(0, 0);
    await new Promise((r) => setTimeout(r, 200));
    const b = new SyncClient({ serverUrl: url, docId, replicaId: 'lb', name: 'Late', color: '#6f42c1' });
    await ready(b);
    await eventually(() => b.remote.get('la')?.name === 'Early');
    a.stop();
    b.stop();
  });
});
