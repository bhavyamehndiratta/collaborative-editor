import type { DocumentSnapshot, Operation } from '@collab/crdt';

/** Everything needed to reopen a document offline and keep syncing the same replica. */
export interface SavedState {
  readonly replicaId: string;
  readonly snapshot: DocumentSnapshot;
  readonly pending: Operation[];
}

export interface StateStore {
  load(docId: string): Promise<SavedState | undefined>;
  save(docId: string, state: SavedState): Promise<void>;
}

/** In memory store for tests. JSON round trip mimics IndexedDB structured cloning. */
export class MemoryStore implements StateStore {
  private readonly data = new Map<string, string>();

  load(docId: string): Promise<SavedState | undefined> {
    const raw = this.data.get(docId);
    return Promise.resolve(raw === undefined ? undefined : (JSON.parse(raw) as SavedState));
  }

  save(docId: string, state: SavedState): Promise<void> {
    this.data.set(docId, JSON.stringify(state));
    return Promise.resolve();
  }
}

/** Browser store: one record per document in a single IndexedDB object store. */
export class IndexedDbStore implements StateStore {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('collab-offline', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('docs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
    return this.dbPromise;
  }

  async load(docId: string): Promise<SavedState | undefined> {
    const db = await this.open();
    return new Promise<SavedState | undefined>((resolve, reject) => {
      const req = db.transaction('docs', 'readonly').objectStore('docs').get(docId);
      req.onsuccess = () => resolve(req.result as SavedState | undefined);
      req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
    });
  }

  async save(docId: string, state: SavedState): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('docs', 'readwrite');
      tx.objectStore('docs').put(state, docId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'));
    });
  }
}
