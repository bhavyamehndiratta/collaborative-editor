import { describe, expect, it } from 'vitest';
import { CrdtDocument, type Operation } from './index.js';

function typeText(doc: CrdtDocument, text: string, at = doc.length): Operation[] {
  return [...text].map((ch, i) => doc.insert(at + i, ch));
}

function typeBackwards(doc: CrdtDocument, text: string, at = 0): Operation[] {
  return [...text].reverse().map((ch) => doc.insert(at, ch));
}

function applyAll(doc: CrdtDocument, ops: Operation[]): void {
  for (const op of ops) expect(doc.apply(op)).toBe('applied');
}

describe('local editing', () => {
  it('starts empty', () => {
    const d = new CrdtDocument('a');
    expect(d.text()).toBe('');
    expect(d.length).toBe(0);
  });

  it('appends, prepends and inserts in the middle', () => {
    const d = new CrdtDocument('a');
    typeText(d, 'ace');
    d.insert(1, 'b');
    d.insert(3, 'd');
    d.insert(0, '>');
    d.insert(d.length, '<');
    expect(d.text()).toBe('>abcde<');
  });

  it('deletes characters', () => {
    const d = new CrdtDocument('a');
    typeText(d, 'hello');
    d.delete(0);
    d.delete(d.length - 1);
    d.delete(1);
    expect(d.text()).toBe('el');
  });

  it('inserts next to tombstones', () => {
    const d = new CrdtDocument('a');
    typeText(d, 'abc');
    d.delete(1);
    d.insert(1, 'X');
    expect(d.text()).toBe('aXc');
  });

  it('rejects bad input', () => {
    const d = new CrdtDocument('a');
    expect(() => d.insert(1, 'x')).toThrow(RangeError);
    expect(() => d.insert(0, 'xy')).toThrow(RangeError);
    expect(() => d.delete(0)).toThrow(RangeError);
    expect(() => new CrdtDocument('')).toThrow(RangeError);
  });

  it('handles long forward typing without stack overflow', () => {
    const d = new CrdtDocument('a');
    for (let i = 0; i < 20000; i++) d.insert(i, 'x');
    expect(d.length).toBe(20000);
  });
});

describe('remote application', () => {
  it('replays ops on another replica', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const ops = [...typeText(a, 'hello'), a.delete(1), a.insert(1, 'E')];
    applyAll(b, ops);
    expect(b.text()).toBe(a.text());
    expect(b.text()).toBe('hEllo');
  });

  it('is idempotent for inserts and deletes', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const ops = [...typeText(a, 'abc'), a.delete(1)];
    applyAll(b, ops);
    const before = b.text();
    expect(b.apply(ops[0] as Operation)).toBe('duplicate');
    expect(b.apply(ops[3] as Operation)).toBe('applied');
    expect(b.text()).toBe(before);
  });

  it('reports a missing dependency instead of applying', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const ops = typeText(a, 'ab');
    expect(b.apply(ops[1] as Operation)).toBe('missing-dependency');
    expect(b.text()).toBe('');
  });
});

describe('concurrent editing', () => {
  it('converges for concurrent inserts at the same spot in either delivery order', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const c = new CrdtDocument('c');
    const d = new CrdtDocument('d');
    const opsA = typeText(a, 'hello');
    const opsB = typeText(b, 'world');
    applyAll(c, opsA);
    applyAll(c, opsB);
    applyAll(d, opsB);
    applyAll(d, opsA);
    applyAll(a, opsB);
    applyAll(b, opsA);
    expect(c.text()).toBe(d.text());
    expect(a.text()).toBe(c.text());
    expect(b.text()).toBe(c.text());
    expect(['helloworld', 'worldhello']).toContain(c.text());
  });

  it('does not interleave concurrent runs typed backwards', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    const c = new CrdtDocument('c');
    const d = new CrdtDocument('d');
    const opsA = typeBackwards(a, 'abc');
    const opsB = typeBackwards(b, 'xyz');
    applyAll(c, opsA);
    applyAll(c, opsB);
    applyAll(d, opsB);
    applyAll(d, opsA);
    expect(c.text()).toBe(d.text());
    expect(['abcxyz', 'xyzabc']).toContain(c.text());
  });

  it('keeps a concurrent insert next to a character another replica deleted', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    applyAll(b, typeText(a, 'abc'));
    const del = a.delete(1);
    const ins = b.insert(2, 'X');
    expect(a.apply(ins)).toBe('applied');
    expect(b.apply(del)).toBe('applied');
    expect(a.text()).toBe('aXc');
    expect(b.text()).toBe('aXc');
  });

  it('converges for concurrent deletes of the same character', () => {
    const a = new CrdtDocument('a');
    const b = new CrdtDocument('b');
    applyAll(b, typeText(a, 'abc'));
    const delA = a.delete(1);
    const delB = b.delete(1);
    applyAll(a, [delB]);
    applyAll(b, [delA]);
    expect(a.text()).toBe('ac');
    expect(b.text()).toBe('ac');
  });
});
