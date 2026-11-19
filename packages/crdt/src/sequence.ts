import type { Block, CharNode } from './node.js';

/**
 * The full document order (tombstones included) stored as a list of bounded blocks.
 * Each block tracks how many of its elements are visible, so "visible index to element"
 * scans block counts (n / blockSize steps) and then one block (at most blockSize steps).
 * Insert and remove touch one block (a native array splice). Blocks split when they exceed
 * the maximum size, which is amortized O(blockSize) per split.
 */
export class BlockedSequence {
  private readonly blocks: Block[] = [{ nodes: [], visible: 0 }];
  private visibleTotal = 0;
  private total = 0;
  private readonly maxBlock: number;

  constructor(maxBlock = 512) {
    if (!Number.isInteger(maxBlock) || maxBlock < 2) {
      throw new RangeError('block size must be an integer >= 2');
    }
    this.maxBlock = maxBlock;
  }

  get visibleCount(): number {
    return this.visibleTotal;
  }

  get size(): number {
    return this.total;
  }

  first(): CharNode | undefined {
    return this.blocks[0]?.nodes[0];
  }

  next(node: CharNode): CharNode | undefined {
    const block = this.blockOf(node);
    const inBlock = block.nodes[block.nodes.indexOf(node) + 1];
    if (inBlock !== undefined) return inBlock;
    return this.blocks[this.blocks.indexOf(block) + 1]?.nodes[0];
  }

  /** The element at a visible index (tombstones skipped). */
  visibleAt(index: number): CharNode {
    let remaining = index;
    for (const block of this.blocks) {
      if (remaining >= block.visible) {
        remaining -= block.visible;
        continue;
      }
      for (const n of block.nodes) {
        if (n.deleted) continue;
        if (remaining === 0) return n;
        remaining--;
      }
    }
    throw new RangeError(`visible index ${index} out of range`);
  }

  /** Number of visible elements strictly before `node`. */
  visibleBefore(node: CharNode): number {
    const block = this.blockOf(node);
    let count = 0;
    for (const b of this.blocks) {
      if (b === block) break;
      count += b.visible;
    }
    for (const n of block.nodes) {
      if (n === node) break;
      if (!n.deleted) count++;
    }
    return count;
  }

  /** Inserts after `anchor`; an undefined anchor means the start of the sequence. */
  insertAfter(anchor: CharNode | undefined, node: CharNode): void {
    if (anchor === undefined) {
      this.place(this.firstBlock(), 0, node);
      return;
    }
    const block = this.blockOf(anchor);
    this.place(block, block.nodes.indexOf(anchor) + 1, node);
  }

  /** Inserts before `anchor`; an undefined anchor means the start of the sequence. */
  insertBefore(anchor: CharNode | undefined, node: CharNode): void {
    if (anchor === undefined) {
      this.place(this.firstBlock(), 0, node);
      return;
    }
    const block = this.blockOf(anchor);
    this.place(block, block.nodes.indexOf(anchor), node);
  }

  remove(node: CharNode): void {
    const block = this.blockOf(node);
    const i = block.nodes.indexOf(node);
    if (i < 0) throw new Error('internal: node missing from its block');
    block.nodes.splice(i, 1);
    this.total--;
    if (!node.deleted) {
      block.visible--;
      this.visibleTotal--;
    }
    node.block = undefined;
    if (block.nodes.length === 0 && this.blocks.length > 1) {
      this.blocks.splice(this.blocks.indexOf(block), 1);
    }
  }

  /** Marks an element deleted and updates counts. Returns false if it was already deleted. */
  markDeleted(node: CharNode): boolean {
    if (node.deleted) return false;
    const block = this.blockOf(node);
    node.deleted = true;
    block.visible--;
    this.visibleTotal--;
    return true;
  }

  *[Symbol.iterator](): IterableIterator<CharNode> {
    for (const block of this.blocks) yield* block.nodes;
  }

  /** Self check used by tests: counts, block sizes and node to block pointers. */
  isConsistent(): boolean {
    let total = 0;
    let visible = 0;
    for (const block of this.blocks) {
      if (block.nodes.length > this.maxBlock) return false;
      if (block.nodes.length === 0 && this.blocks.length > 1) return false;
      let v = 0;
      for (const n of block.nodes) {
        if (n.block !== block) return false;
        if (!n.deleted) v++;
      }
      if (v !== block.visible) return false;
      total += block.nodes.length;
      visible += v;
    }
    return total === this.total && visible === this.visibleTotal;
  }

  private firstBlock(): Block {
    const b = this.blocks[0];
    if (b === undefined) throw new Error('internal: no blocks');
    return b;
  }

  private blockOf(node: CharNode): Block {
    if (node.block === undefined) throw new Error('internal: node is not in the sequence');
    return node.block;
  }

  private place(block: Block, index: number, node: CharNode): void {
    block.nodes.splice(index, 0, node);
    node.block = block;
    this.total++;
    if (!node.deleted) {
      block.visible++;
      this.visibleTotal++;
    }
    if (block.nodes.length > this.maxBlock) this.split(block);
  }

  private split(block: Block): void {
    const moved = block.nodes.splice(block.nodes.length >> 1);
    let visible = 0;
    const fresh: Block = { nodes: moved, visible: 0 };
    for (const n of moved) {
      n.block = fresh;
      if (!n.deleted) visible++;
    }
    fresh.visible = visible;
    block.visible -= visible;
    this.blocks.splice(this.blocks.indexOf(block) + 1, 0, fresh);
  }
}
