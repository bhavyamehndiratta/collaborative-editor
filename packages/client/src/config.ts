export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

const PALETTE = ['#d73a49', '#005cc5', '#22863a', '#b08800', '#6f42c1', '#e36209', '#0e8a8a', '#c2185b'];

export function newReplicaId(): string {
  return `r-${crypto.randomUUID().slice(0, 8)}`;
}

/** A stable display name per browser, and a color derived from the replica id. */
export function localIdentity(replicaId: string): { name: string; color: string } {
  let name: string | null = null;
  try {
    name = new URLSearchParams(location.search).get('name') ?? sessionStorage.getItem('collab-name');
    if (name === null) {
      name = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
      sessionStorage.setItem('collab-name', name);
    }
  } catch {
    name = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
  }
  let hash = 0;
  for (const ch of replicaId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { name, color: PALETTE[hash % PALETTE.length] ?? '#005cc5' };
}
