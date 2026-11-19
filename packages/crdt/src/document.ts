import { compareIds, idKey, ROOT_ID } from './id.js';
import { newNode, type CharNode } from './node.js';
import { BlockedSequence } from './sequence.js';
import type {
  ApplyResult,
  DeleteOp,
  DocumentSnapshot,
  Id,
  InsertOp,
  Operation,
  ReceiveResult,
  Side,
  SnapshotNode,
} from './types.js';
import { VersionVector } from './version-vector.js';

export interface DocumentOptions {
  /** Maximum elements per block of the internal sequence. Default 512. Tests use small values. */
  readonly blockSize?: number;
}

/** Returns the index the node was inserted at. */
function insertSorted(list: CharNode[], node: CharNode): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midNode = list[mid];
    if (midNode !== undefined && compareIds(midNode.id, node.id) < 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, node);
  return lo;
}

/**
 * Fugue sequence CRDT.
 *
 * The tree (parent, side, siblings ordered by id) defines the order. A BlockedSequence mirrors
 * the in-order traversal so that index lookups do not walk the tree. A local insert goes
 * "immediately after the left origin" in the sequence, so it never walks the tree. A remote
 * insert is placed relative to its previous or next sibling, which walks down one subtree
 * boundary (O(depth of that subtree), short in practice).
 *
 * One element per UTF-16 code unit. Use `receive` for remote operations: it deduplicates,
 * buffers out of order operations, and keeps the version vector exact. `apply` is the low
 * level structural step.
 */
export class CrdtDocument {
  readonly replicaId: string;
  private counter = 0;
  private readonly root: CharNode = newNode(ROOT_ID, '', undefined, 'R');
  private readonly nodes = new Map<string, CharNode>();
  private readonly seq: BlockedSequence;
  private readonly vv = new VersionVector();
  private readonly buffer = new Map<string, Map<number, Operation>>();

  constructor(replicaId: string, options: DocumentOptions = {}) {
    if (replicaId === '') throw new RangeError('replicaId must not be empty');
    this.replicaId = replicaId;
    this.seq = new BlockedSequence(options.blockSize);
    this.nodes.set(idKey(ROOT_ID), this.root);
  }

  get length(): number {
    return this.seq.visibleCount;
  }

  /** Elements stored, tombstones included, excluding the virtual root. */
  get nodeCount(): number {
    return this.seq.size;
  }

  get tombstoneCount(): number {
    return this.seq.size - this.seq.visibleCount;
  }

  /** Remote operations waiting for a dependency. */
  get bufferedCount(): number {
    let n = 0;
    for (const byCounter of this.buffer.values()) n += byCounter.size;
    return n;
  }

  version(): VersionVector {
    return this.vv.clone();
  }

  text(): string {
    const parts: string[] = [];
    for (const n of this.seq) if (!n.deleted) parts.push(n.value);
    return parts.join('');
  }

  /** Ids of all elements in document order, tombstones included. */
  orderedIds(): Id[] {
    return [...this.seq].map((n) => n.id);
  }

  /** Ids of visible elements in document order. */
  visibleIds(): Id[] {
    return [...this.seq].filter((n) => !n.deleted).map((n) => n.id);
  }

  /**
   * Self check for tests: the sequence must equal the tree traversal, and all counts and
   * block pointers must be consistent.
   */
  verifyStructure(): boolean {
    const fromTree = this.treeOrder();
    const fromSeq = [...this.seq];
    if (fromTree.length !== fromSeq.length) return false;
    for (let i = 0; i < fromTree.length; i++) if (fromTree[i] !== fromSeq[i]) return false;
    if (fromSeq.length !== this.nodes.size - 1) return false;
    if (fromSeq.filter((n) => !n.deleted).length !== this.seq.visibleCount) return false;
    return this.seq.isConsistent();
  }

  /** Serializable state: nodes in parent-first order, version vector, and buffered operations. */
  snapshot(): DocumentSnapshot {
    const nodes: SnapshotNode[] = [];
    const stack: CharNode[] = [this.root];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n === undefined) break;
      for (const c of [...n.left, ...n.right]) {
        let deletedBy: Id | null = null;
        if (c.deleted) {
          if (c.deletedBy === undefined) throw new Error('internal: deleted node without deletedBy');
          deletedBy = c.deletedBy;
        }
        nodes.push({ id: c.id, parent: n.id, side: c.side, value: c.value, deletedBy });
        stack.push(c);
      }
    }
    const pending: Operation[] = [];
    for (const byCounter of this.buffer.values()) {
      for (const op of byCounter.values()) pending.push(op);
    }
    return { version: this.vv.toJSON(), nodes, pending };
  }

  static fromSnapshot(
    replicaId: string,
    snap: DocumentSnapshot,
    options: DocumentOptions = {},
  ): CrdtDocument {
    const doc = new CrdtDocument(replicaId, options);
    for (const n of snap.nodes) {
      doc.integrateInsert({
        type: 'insert',
        id: n.id,
        parent: n.parent,
        side: n.side,
        value: n.value,
      });
      if (n.deletedBy !== null) {
        const node = doc.nodes.get(idKey(n.id));
        if (node !== undefined) doc.markDeleted(node, n.deletedBy);
      }
    }
    for (const [replica, counter] of Object.entries(snap.version)) doc.vv.set(replica, counter);
    doc.counter = snap.version[replicaId] ?? 0;
    for (const op of snap.pending) doc.bufferOp(op);
    return doc;
  }

  /** Stable position marker: the element just before `index` (the virtual root for index 0). */
  anchorAt(index: number): Id {
    if (!Number.isInteger(index) || index < 0 || index > this.seq.visibleCount) {
      throw new RangeError(`index ${index} out of range 0..${this.seq.visibleCount}`);
    }
    return index === 0 ? ROOT_ID : this.seq.visibleAt(index - 1).id;
  }

  /**
   * Current index of an anchor. A deleted anchor resolves to the position where it was.
   * Undefined if the element is unknown (not received yet, or compacted away).
   */
  indexOfAnchor(anchor: Id): number | undefined {
    const node = this.nodes.get(idKey(anchor));
    if (node === undefined) return undefined;
    if (node === this.root) return 0;
    return this.seq.visibleBefore(node) + (node.deleted ? 0 : 1);
  }

  insert(index: number, value: string): InsertOp {
    if (value.length !== 1) throw new RangeError('value must be exactly one UTF-16 code unit');
    const visible = this.seq.visibleCount;
    if (!Number.isInteger(index) || index < 0 || index > visible) {
      throw new RangeError(`index ${index} out of range 0..${visible}`);
    }
    const leftOrigin = index === 0 ? this.root : this.seq.visibleAt(index - 1);
    let parent: CharNode;
    let side: Side;
    if (leftOrigin.right.length === 0) {
      parent = leftOrigin;
      side = 'R';
    } else {
      const successor = leftOrigin === this.root ? this.seq.first() : this.seq.next(leftOrigin);
      if (successor === undefined) throw new Error('internal: missing successor');
      parent = successor;
      side = 'L';
    }
    const op: InsertOp = {
      type: 'insert',
      id: { replica: this.replicaId, counter: ++this.counter },
      parent: parent.id,
      side,
      value,
    };
    this.integrateInsert(op);
    this.vv.set(this.replicaId, this.counter);
    return op;
  }

  delete(index: number): DeleteOp {
    const visible = this.seq.visibleCount;
    if (!Number.isInteger(index) || index < 0 || index >= visible) {
      throw new RangeError(`index ${index} out of range 0..${visible - 1}`);
    }
    const target = this.seq.visibleAt(index);
    const id: Id = { replica: this.replicaId, counter: ++this.counter };
    this.markDeleted(target, id);
    this.vv.set(this.replicaId, this.counter);
    return { type: 'delete', id, target: target.id };
  }

  /**
   * Low level structural application. Does not touch the version vector or the buffer.
   * Prefer `receive`.
   */
  apply(op: Operation): ApplyResult {
    if (op.type === 'insert') {
      if (this.nodes.has(idKey(op.id))) return 'duplicate';
      if (!this.nodes.has(idKey(op.parent))) return 'missing-dependency';
      this.integrateInsert(op);
      return 'applied';
    }
    const target = this.nodes.get(idKey(op.target));
    if (target === undefined) return 'missing-dependency';
    this.markDeleted(target, op.id);
    return 'applied';
  }

  /**
   * Receives a remote operation. An operation is applied only when it is the next one from
   * its replica (counter = vector + 1) and the element it refers to exists. Anything else
   * waits in the buffer. Duplicates are detected through the version vector.
   */
  receive(op: Operation): ReceiveResult {
    if (this.vv.has(op.id)) return 'duplicate';
    if (op.type === 'insert' && !this.nodes.has(idKey(op.parent)) && this.vv.has(op.parent)) {
      return 'stale';
    }
    if (!this.isReady(op)) {
      this.bufferOp(op);
      return 'buffered';
    }
    this.commit(op);
    this.drain();
    return 'applied';
  }

  /**
   * Removes tombstones that are leaves and whose delete is covered by `stable`, cascading to
   * parents that become removable. Returns how many elements were removed.
   *
   * SAFETY: only valid when no replica can still produce an operation that refers to a
   * removed element, and every replica applies the same compaction. A replica that later sends
   * such an operation gets 'stale' and must resync. Callers (the server, at snapshot time)
   * establish this; the document cannot check it.
   */
  compact(stable: VersionVector): number {
    let removed = 0;
    const work: CharNode[] = [];
    for (const n of this.nodes.values()) if (this.isRemovable(n, stable)) work.push(n);
    while (work.length > 0) {
      const n = work.pop();
      if (n === undefined || !this.nodes.has(idKey(n.id)) || !this.isRemovable(n, stable)) continue;
      const parent = n.parent;
      if (parent !== undefined) {
        const list = n.side === 'L' ? parent.left : parent.right;
        const i = list.indexOf(n);
        if (i >= 0) list.splice(i, 1);
      }
      this.seq.remove(n);
      this.nodes.delete(idKey(n.id));
      removed++;
      if (parent !== undefined && parent !== this.root) work.push(parent);
    }
    return removed;
  }

  private isRemovable(n: CharNode, stable: VersionVector): boolean {
    return (
      n !== this.root &&
      n.deleted &&
      n.left.length === 0 &&
      n.right.length === 0 &&
      n.deletedBy !== undefined &&
      stable.has(n.deletedBy)
    );
  }

  private markDeleted(target: CharNode, by: Id): void {
    if (this.seq.markDeleted(target)) target.deletedBy = by;
  }

  private hasDependency(op: Operation): boolean {
    if (op.type === 'insert') return this.nodes.has(idKey(op.parent));
    return this.nodes.has(idKey(op.target)) || this.vv.has(op.target);
  }

  private isReady(op: Operation): boolean {
    return op.id.counter === this.vv.get(op.id.replica) + 1 && this.hasDependency(op);
  }

  private commit(op: Operation): void {
    if (op.type === 'insert') {
      this.integrateInsert(op);
    } else {
      const target = this.nodes.get(idKey(op.target));
      if (target !== undefined) this.markDeleted(target, op.id);
    }
    this.vv.set(op.id.replica, op.id.counter);
  }

  private bufferOp(op: Operation): void {
    let byCounter = this.buffer.get(op.id.replica);
    if (byCounter === undefined) {
      byCounter = new Map();
      this.buffer.set(op.id.replica, byCounter);
    }
    byCounter.set(op.id.counter, op);
  }

  private drain(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (const [replica, byCounter] of this.buffer) {
        for (;;) {
          const next = byCounter.get(this.vv.get(replica) + 1);
          if (next === undefined || !this.hasDependency(next)) break;
          byCounter.delete(next.id.counter);
          this.commit(next);
          progress = true;
        }
        if (byCounter.size === 0) this.buffer.delete(replica);
      }
    }
  }

  private integrateInsert(op: InsertOp): void {
    const parent = this.nodes.get(idKey(op.parent));
    if (parent === undefined) throw new Error('integrateInsert: parent not found');
    const node = newNode(op.id, op.value, parent, op.side);
    const list = op.side === 'L' ? parent.left : parent.right;
    const idx = insertSorted(list, node);
    const prev = list[idx - 1];
    const next = list[idx + 1];
    if (prev !== undefined) {
      this.seq.insertAfter(this.lastOfSubtree(prev), node);
    } else if (op.side === 'R') {
      this.seq.insertAfter(this.anchor(parent), node);
    } else if (next !== undefined) {
      this.seq.insertBefore(this.firstOfSubtree(next), node);
    } else {
      this.seq.insertBefore(this.anchor(parent), node);
    }
    this.nodes.set(idKey(op.id), node);
  }

  /** The virtual root is not stored in the sequence; an undefined anchor means the start. */
  private anchor(n: CharNode): CharNode | undefined {
    return n === this.root ? undefined : n;
  }

  private firstOfSubtree(start: CharNode): CharNode {
    let n = start;
    for (;;) {
      const l = n.left[0];
      if (l === undefined) return n;
      n = l;
    }
  }

  private lastOfSubtree(start: CharNode): CharNode {
    let n = start;
    for (;;) {
      const r = n.right[n.right.length - 1];
      if (r === undefined) return n;
      n = r;
    }
  }

  /** Reference order from the tree itself (iterative in-order traversal), for verification. */
  private treeOrder(): CharNode[] {
    const out: CharNode[] = [];
    const stack: Array<{ node: CharNode; next: number }> = [{ node: this.root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const n = top.node;
      const leftChild = n.left[top.next];
      if (top.next < n.left.length && leftChild !== undefined) {
        top.next++;
        stack.push({ node: leftChild, next: 0 });
      } else if (top.next === n.left.length) {
        top.next++;
        if (n !== this.root) out.push(n);
      } else {
        const rightChild = n.right[top.next - n.left.length - 1];
        if (rightChild !== undefined) {
          top.next++;
          stack.push({ node: rightChild, next: 0 });
        } else {
          stack.pop();
        }
      }
    }
    return out;
  }
}
