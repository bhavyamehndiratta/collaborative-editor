import { describe, expect, it } from 'vitest';
import { CrdtDocument, ROOT_ID } from './index.js';

describe('anchors', () => {
  it('index 0 anchors to the root and resolves back to 0', () => {
    const a = new CrdtDocument('a');
    expect(a.anchorAt(0)).toEqual(ROOT_ID);
    expect(a.indexOfAnchor(ROOT_ID)).toBe(0);
  });

  it('follow their element through edits before, at and after the anchor', () => {
    const a = new CrdtDocument('a', { blockSize: 4 });
    for (const [i, ch] of [...'hello'].entries()) a.insert(i, ch);
    const anchor = a.anchorAt(5);
    a.insert(0, 'X');
    expect(a.indexOfAnchor(anchor)).toBe(6);
    a.insert(a.length, '!');
    expect(a.indexOfAnchor(anchor)).toBe(6);
    a.delete(0);
    expect(a.indexOfAnchor(anchor)).toBe(5);
  });

  it('a deleted anchor resolves to where it was, and unknown ids are undefined', () => {
    const a = new CrdtDocument('a');
    for (const [i, ch] of [...'abc'].entries()) a.insert(i, ch);
    const anchor = a.anchorAt(2);
    a.delete(1);
    expect(a.indexOfAnchor(anchor)).toBe(1);
    expect(a.indexOfAnchor({ replica: 'nobody', counter: 9 })).toBeUndefined();
  });

  it('rejects out of range indexes', () => {
    const a = new CrdtDocument('a');
    expect(() => a.anchorAt(1)).toThrow(RangeError);
  });
});
