import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore, type StateStore } from '../../packages/client/src/offline-store.js';
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

async function open(
  url: string,
  docId: string,
  store: StateStore,
  fallbackReplicaId: string,
): Promise<SyncClient> {
  const saved = await store.load(docId);
  const client = new SyncClient({
    serverUrl: url,
    docId,
    replicaId: saved?.replicaId ?? fallbackReplicaId,
    store,
    initial: saved,
  });
  await new Promise<void>((resolve) => {
    client.onReady = resolve;
    client.start();
  });
  return client;
}

describe('offline editing', () => {
  let server: RunningServer;
  let url: string;
  beforeAll(async () => {
    server = await startServer(loadConfig({ ...process.env, PORT: '0' }));
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.close();
  });

  it('keeps edits across a reload while offline and merges them on reconnect', async () => {
    const res = await fetch(`${url}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'offline-reload' }),
    });
    const { id: docId } = (await res.json()) as { id: string };
    const store = new MemoryStore();

    const a1 = await open(url, docId, store, 'off-a');
    const b = await open(url, docId, new MemoryStore(), 'off-b');
    a1.applyLocal(0, 0, 'hello');
    await eventually(() => b.text() === 'hello' && a1.unackedCount === 0);
    a1.stop();

    // Reload with the server unreachable: same replica id, same text, shown immediately.
    const a2 = await open('http://127.0.0.1:1', docId, store, 'unused');
    expect(a2.replicaId).toBe('off-a');
    expect(a2.text()).toBe('hello');
    a2.applyLocal(5, 0, ' world');
    expect(a2.unackedCount).toBe(6);
    a2.stop();

    // Meanwhile someone else edits the same document.
    b.applyLocal(0, 0, 'X');

    // Reload again, now online: the queued edits survive and merge.
    const a3 = await open(url, docId, store, 'unused');
    expect(a3.unackedCount).toBe(6);
    await eventually(
      () => a3.text() === 'Xhello world' && b.text() === 'Xhello world' && a3.unackedCount === 0,
    );
    a3.stop();
    b.stop();
  });
});
