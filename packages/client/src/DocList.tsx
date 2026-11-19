import { useEffect, useState } from 'react';
import { SERVER_URL } from './config.js';

interface DocInfo {
  id: string;
  name: string;
  createdAt: string;
}

export function DocList() {
  const [docs, setDocs] = useState<DocInfo[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();

  async function load(): Promise<void> {
    try {
      const res = await fetch(`${SERVER_URL}/api/docs`);
      setDocs((await res.json()) as DocInfo[]);
      setError(undefined);
    } catch {
      setError('Cannot reach the server');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (name.trim() === '') return;
    const res = await fetch(`${SERVER_URL}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const doc = (await res.json()) as DocInfo;
    window.location.hash = `#/doc/${doc.id}`;
  }

  return (
    <main className="page">
      <h1>Documents</h1>
      <form onSubmit={(e) => void create(e)} className="row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New document name"
          maxLength={100}
        />
        <button type="submit">Create</button>
      </form>
      {error !== undefined && <p className="error">{error}</p>}
      <ul className="docs">
        {docs.map((d) => (
          <li key={d.id}>
            <a href={`#/doc/${d.id}`}>{d.name}</a>
            <span className="muted">{new Date(d.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
