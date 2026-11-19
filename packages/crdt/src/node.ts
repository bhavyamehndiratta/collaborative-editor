import type { Id, Side } from './types.js';

export interface Block {
  nodes: CharNode[];
  visible: number;
}

export interface CharNode {
  readonly id: Id;
  readonly value: string;
  readonly parent: CharNode | undefined;
  readonly side: Side;
  deleted: boolean;
  deletedBy: Id | undefined;
  block: Block | undefined;
  readonly left: CharNode[];
  readonly right: CharNode[];
}

export function newNode(id: Id, value: string, parent: CharNode | undefined, side: Side): CharNode {
  return {
    id,
    value,
    parent,
    side,
    deleted: false,
    deletedBy: undefined,
    block: undefined,
    left: [],
    right: [],
  };
}
