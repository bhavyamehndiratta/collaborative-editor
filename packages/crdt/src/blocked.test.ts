import { describe, expect, it } from 'vitest';
import { CrdtDocument, type Operation } from './index.js';

function lcg(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s % n;
  };
}

describe('blocked sequence with tiny blocks', () => {
  it('matches a plain string model under random local edits and replicates exactly', () => {
    const doc = new CrdtDocument('a', { blockSize: 4 });
    const ops: Operation[] = [];
    const rnd = lcg(12345);
    let model = '';
    for (let i = 0; i < 3000; i++) {
      if (model.length > 0 && rnd(3) === 0) {
        const at = rnd(model.length);
        ops.push(doc.delete(at));
        model = model.slice(0, at) + model.slice(at + 1);
      } else {
        const at = rnd(model.length + 1);
        const ch = String.fromCharCode(97 + rnd(26));
        ops.push(doc.insert(at, ch));
        model = model.slice(0, at) + ch + model.slice(at);
      }
    }
    expect(doc.text()).toBe(model);
    expect(doc.length).toBe(model.length);
    expect(doc.verifyStructure()).toBe(true);

    const replica = new CrdtDocument('b', { blockSize: 4 });
    for (const op of ops) replica.receive(op);
    expect(replica.text()).toBe(model);
    expect(replica.verifyStructure()).toBe(true);
  });

  it('keeps structure valid through compaction with tiny blocks', () => {
    const doc = new CrdtDocument('a', { blockSize: 4 });
    for (let i = 0; i < 200; i++) doc.insert(i, 'x');
    for (let i = 0; i < 150; i++) doc.delete(doc.length - 1);
    expect(doc.compact(doc.version())).toBe(150);
    expect(doc.length).toBe(50);
    expect(doc.nodeCount).toBe(50);
    expect(doc.verifyStructure()).toBe(true);
  });

  it('handles long forward and backward typing quickly', () => {
    const fwd = new CrdtDocument('a');
    for (let i = 0; i < 100000; i++) fwd.insert(i, 'x');
    expect(fwd.length).toBe(100000);
    const back = new CrdtDocument('b');
    for (let i = 0; i < 50000; i++) back.insert(0, 'x');
    expect(back.length).toBe(50000);
    expect(fwd.verifyStructure()).toBe(true);
    expect(back.verifyStructure()).toBe(true);
  });
});
