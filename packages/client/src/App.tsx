import { useEffect, useState } from 'react';
import { DocList } from './DocList.js';
import { EditorPage } from './EditorPage.js';

function currentRoute(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function App() {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const onChange = (): void => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const match = /^\/doc\/([0-9a-f-]{36})$/i.exec(route);
  const docId = match?.[1];
  return docId !== undefined ? <EditorPage key={docId} docId={docId} /> : <DocList />;
}
