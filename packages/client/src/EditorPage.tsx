import { useEffect, useRef, useState } from 'react';
import { localIdentity, newReplicaId, SERVER_URL } from './config.js';
import { EditorBinding } from './editor-binding.js';
import { IndexedDbStore, MemoryStore, type SavedState, type StateStore } from './offline-store.js';
import { SyncClient, type RemotePresence, type Status } from './sync-client.js';

const store = new IndexedDbStore();

/**
 * Only one tab per browser may own a document's saved replica id. Other tabs on the same
 * document run without persistence and get a fresh replica id, so two tabs never share one.
 */
async function claimDoc(docId: string): Promise<{ primary: boolean; release: () => void }> {
  if (!('locks' in navigator)) return { primary: true, release: () => {} };
  return new Promise((resolve) => {
    void navigator.locks.request(`collab-doc-${docId}`, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        resolve({ primary: false, release: () => {} });
        return undefined;
      }
      return new Promise<void>((release) => resolve({ primary: true, release: () => release() }));
    });
  });
}

export function EditorPage({ docId }: { docId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [ready, setReady] = useState(false);
  const [unsynced, setUnsynced] = useState(0);
  const [, setPeers] = useState<RemotePresence[]>([]);
  const [me, setMe] = useState('');

  useEffect(() => {
    let cancelled = false;
    let cleanup = (): void => {};

    void (async () => {
      const claim = await claimDoc(docId);
      if (cancelled) {
        claim.release();
        return;
      }
      const syncStore: StateStore = claim.primary ? store : new MemoryStore();
      let saved: SavedState | undefined;
      if (claim.primary) {
        try {
          saved = await store.load(docId);
        } catch {
          saved = undefined;
        }
      }
      if (cancelled) {
        claim.release();
        return;
      }

      const replicaId = saved?.replicaId ?? newReplicaId();
      const { name, color } = localIdentity(replicaId);
      setMe(name);
      const sync = new SyncClient({
        serverUrl: SERVER_URL,
        docId,
        replicaId,
        name,
        color,
        store: syncStore,
        initial: saved,
      });
      let binding: EditorBinding | undefined;
      sync.onStatus = setStatus;
      sync.onPending = setUnsynced;
      sync.onReady = () => {
        if (host.current !== null) binding = new EditorBinding(host.current, sync);
        const redraw = sync.onPresence;
        sync.onPresence = () => {
          redraw();
          setPeers([...sync.remote.values()]);
        };
        setReady(true);
      };
      const flush = (): void => sync.flushSave();
      window.addEventListener('pagehide', flush);
      sync.start();
      cleanup = () => {
        window.removeEventListener('pagehide', flush);
        binding?.destroy();
        sync.stop();
        claim.release();
      };
    })();

    return () => {
      cancelled = true;
      cleanup();
      setReady(false);
      setPeers([]);
      setUnsynced(0);
    };
  }, [docId]);

  return (
    <main className="page wide">
      <header className="bar">
        <a href="#/">All documents</a>
        <span className="peers">
          <span className="peer"><strong>You: {me}</strong></span>
        </span>
        <span className={`status ${status}`}>
          {status}
          {unsynced > 0 ? ` (${unsynced} unsynced)` : ''}
        </span>
      </header>
      {!ready && <p className="muted">Loading document...</p>}
      <div ref={host} className="editor" />
    </main>
  );
}
