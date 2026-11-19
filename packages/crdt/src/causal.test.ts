import { describe, expect, it } from 'vitest';
import { CrdtDocument, VersionVector, type Operation } from './index.js';

function typeText(doc: CrdtDocument, text: string): Operation[] {
  return [...text].map((ch, i) => doc.insert(i, ch));
}

describe('version vector', () => {
  it('tracks, merges and compares', () => {
    const a = new VersionVector();
    a.set('x', 3);
    a.set('y', 1);
    a.set('x', 2);
    expect(a.get('x')).toBe(3);
    expect(a.get('z')).toBe(0);
    expect(a.has({ replica: 'x', counter: 3 })).toBe(true);
    expect(a.has({ replica: 'x', counter: 4 })).toBe(false);
    const b = new VersionVector();
    b.set('x', 1);
    expect(a.covers(b)).toBe(true);
    expect(b.covers(a)).toBe(false);
    b.merge(a);
    expect(b.toJSON()).toEqual({ x: 3, y: 1 });
    expect(VersionVector.fromJSON(b.toJSON()).toJSON()).toEqual(b.toJSON());
  });

  it('local operations advance the own entry', () => {
    const a = new CrdtDocument('a');
    typeText(a, 'abc');
    a.delete(0);
    expect(a.version().get('a')).toBe(4);
  });
});

describe('causal buffering', () => {
  it('buffers operations delivered in reverse and applies them when the prefix arrives', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const ops = typeText(a, 'hello');
    const results = [...ops].reverse().map((op) => b.receive(op));
    expect(results).toEqual(['buffered', 'buffered', 'buffered', 'buffered', 'applied']);
    expect(b.bufferedCount).toBe(0);
    expect(b.text()).toBe('hello');
    expect(b.version().get('a')).toBe(5);
  });

  it('buffers a delete that arrives before its target', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const [i1, i2] = typeText(a, 'ab') as [Operation, Operation];
    const del = a.delete(0);
    expect(b.receive(del)).toBe('buffered');
    expect(b.receive(i1)).toBe('applied');
    expect(b.receive(i2)).toBe('applied');
    expect(b.bufferedCount).toBe(0);
    expect(b.text()).toBe('b');
  });

  it('waits for a dependency that comes from a different replica', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const c = new CrdtDocument('c');
    const opA = a.insert(0, 'a');
    b.receive(opA);
    const opB = b.insert(1, 'x');
    expect(c.receive(opB)).toBe('buffered');
    expect(c.bufferedCount).toBe(1);
    expect(c.receive(opA)).toBe('applied');
    expect(c.bufferedCount).toBe(0);
    expect(c.text()).toBe('ax');
  });

  it('detects duplicates, including duplicates of buffered operations', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const [i1, i2] = typeText(a, 'ab') as [Operation, Operation];
    expect(b.receive(i2)).toBe('buffered');
    expect(b.receive(i2)).toBe('buffered');
    expect(b.bufferedCount).toBe(1);
    expect(b.receive(i1)).toBe('applied');
    expect(b.receive(i1)).toBe('duplicate');
    expect(b.receive(i2)).toBe('duplicate');
    expect(b.text()).toBe('ab');
  });

  it('ignores an operation echoed back to its author', () => {
    const a = new CrdtDocument('a');
    const op = a.insert(0, 'x');
    expect(a.receive(op)).toBe('duplicate');
    expect(a.text()).toBe('x');
  });
});

describe('compaction', () => {
  it('removes stable leaf tombstones, cascading, and keeps text and order', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const ops = [...typeText(a, 'abcd'), a.delete(3), a.delete(2)];
    for (const op of ops) b.receive(op);
    expect(a.tombstoneCount).toBe(2);
    expect(a.compact(a.version())).toBe(2);
    expect(b.compact(b.version())).toBe(2);
    expect(a.text()).toBe('ab');
    expect(b.text()).toBe('ab');
    expect(a.nodeCount).toBe(2);
    expect(a.tombstoneCount).toBe(0);
  });

  it('keeps tombstones whose delete is not covered by the stable vector', () => {
    const a = new CrdtDocument('a');
    typeText(a, 'ab');
    a.delete(1);
    expect(a.compact(new VersionVector())).toBe(0);
    expect(a.tombstoneCount).toBe(1);
  });

  it('keeps tombstones that still have descendants', () => {
    const a = new CrdtDocument('a');
    typeText(a, 'abc');
    a.delete(0);
    expect(a.compact(a.version())).toBe(0);
    expect(a.text()).toBe('bc');
  });

  it('treats a delete of an already compacted element as a no-op', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    b.receive(a.insert(0, 'x'));
    const delA = a.delete(0);
    const delB = b.delete(0);
    expect(a.compact(a.version())).toBe(1);
    expect(a.receive(delB)).toBe('applied');
    expect(a.text()).toBe('');
    expect(a.nodeCount).toBe(0);
    expect(b.receive(delA)).toBe('applied');
    expect(b.text()).toBe('');
  });

  it('reports stale when an insert refers to a compacted parent', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    b.receive(a.insert(0, 'x'));
    const opY = b.insert(1, 'y');
    a.delete(0);
    expect(a.compact(a.version())).toBe(1);
    expect(a.receive(opY)).toBe('stale');
    expect(a.text()).toBe('');
  });
});
