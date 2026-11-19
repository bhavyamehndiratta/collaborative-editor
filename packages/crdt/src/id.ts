import type { Id } from './types.js';

export const ROOT_ID: Id = { replica: '', counter: 0 };

export function idKey(id: Id): string {
  return `${id.replica}:${id.counter}`;
}

export function compareIds(a: Id, b: Id): number {
  if (a.replica < b.replica) return -1;
  if (a.replica > b.replica) return 1;
  return a.counter - b.counter;
}
