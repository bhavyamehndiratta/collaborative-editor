import { describe, expect, it } from 'vitest';
import { CrdtDocument, idKey, type Id } from './index.js';

function lcg(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s % n;
  };
}
const keys = (ids: Id[]): string[] => ids.map(idKey);

describe('snapshot', () => {
  it('round trips through JSON with tombstones, compaction and buffered operations', () => {
    const a = new CrdtDocument('a', { blockSize: 4 });
    const rnd = lcg(7);
    let len = 0;
    for (let i = 0; i < 600; i++) {
      if (len > 0 && rnd(3) === 0) {
        a.delete(rnd(len));
        len--;
      } else {
        a.insert(rnd(len + 1), String.fromCharCode(97 + rnd(26)));
        len++;
      }
    }
    a.compact(a.version());
    const c = new CrdtDocument('c');
    const o1 = c.insert(0, 'x');
    const o2 = c.insert(1, 'y');
    expect(a.receive(o2)).toBe('buffered');

    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const b = CrdtDocument.fromSnapshot('srv', snap, { blockSize: 4 });
    expect(b.text()).toBe(a.text());
    expect(keys(b.orderedIds())).toEqual(keys(a.orderedIds()));
    expect(b.verifyStructure()).toBe(true);
    expect(b.version().toJSON()).toEqual(a.version().toJSON());
    expect(b.bufferedCount).toBe(1);

    expect(a.receive(o1)).toBe('applied');
    expect(b.receive(o1)).toBe('applied');
    expect(b.bufferedCount).toBe(0);
    expect(b.text()).toBe(a.text());
    expect(keys(b.orderedIds())).toEqual(keys(a.orderedIds()));
  });

  it('continues own counters after restoring', () => {
    const a = new CrdtDocument('a');
    a.insert(0, 'x');
    a.insert(1, 'y');
    const b = CrdtDocument.fromSnapshot('a', JSON.parse(JSON.stringify(a.snapshot())));
    const op = b.insert(2, 'z');
    expect(op.id.counter).toBe(3);
    expect(b.text()).toBe('xyz');
  });
});
