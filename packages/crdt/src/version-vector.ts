import type { Id } from './types.js';

/**
 * Highest contiguous operation counter seen per replica. Because documents deliver each
 * replica's operations in order (see CrdtDocument.receive), this summarizes the exact set
 * of operations a replica holds.
 */
export class VersionVector {
  private readonly counters = new Map<string, number>();

  get(replica: string): number {
    return this.counters.get(replica) ?? 0;
  }

  /** Raises the entry for a replica; never lowers it. */
  set(replica: string, counter: number): void {
    if (counter > this.get(replica)) this.counters.set(replica, counter);
  }

  /** True if the operation with this id is covered by this vector. */
  has(id: Id): boolean {
    return id.counter <= this.get(id.replica);
  }

  /** True if this vector is at least as far along as `other` for every replica. */
  covers(other: VersionVector): boolean {
    for (const [replica, counter] of other.counters) {
      if (this.get(replica) < counter) return false;
    }
    return true;
  }

  merge(other: VersionVector): void {
    for (const [replica, counter] of other.counters) this.set(replica, counter);
  }

  clone(): VersionVector {
    const copy = new VersionVector();
    copy.merge(this);
    return copy;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  static fromJSON(json: Record<string, number>): VersionVector {
    const v = new VersionVector();
    for (const [replica, counter] of Object.entries(json)) v.set(replica, counter);
    return v;
  }
}
