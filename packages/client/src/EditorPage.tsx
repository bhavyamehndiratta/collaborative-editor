import { useEffect, useRef, useState } from 'react';
import { localIdentity, newReplicaId, SERVER_URL } from './config.js';
import { EditorBinding } from './editor-binding.js';
import { IndexedDbStore, type SavedState } from './offline-store.js';
import { SyncClient, type RemotePresence, type Status } from './sync-client.js';

const store = new IndexedDbStore();

export function EditorPage({ docId }: { docId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [ready, setReady] = useState(false);
  const [unsynced, setUnsynced] = useState(0);
  const [peers, setPeers] = useState<RemotePresence[]>([]);

  useEffect(() => {
    let cancelled = false;
    let cleanup = (): void => {};

    void (async () => {
      let saved: SavedState | undefined;
      try {
        saved = await store.load(docId);
      } catch {
        saved = undefined;
      }
      if (cancelled) return;

      const replicaId = saved?.replicaId ?? newReplicaId();
      const { name, color } = localIdentity(replicaId);
      const sync = new SyncClient({
        serverUrl: SERVER_URL,
        docId,
        replicaId,
        name,
        color,
        store,
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
          {peers.map((p) => (
            <span key={p.replicaId} className="peer">
              <span className="dot" style={{ backgroundColor: p.color }} />
              {p.name}
            </span>
          ))}
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
