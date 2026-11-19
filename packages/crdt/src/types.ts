export type Side = 'L' | 'R';

export interface Id {
  readonly replica: string;
  readonly counter: number;
}

export interface InsertOp {
  readonly type: 'insert';
  readonly id: Id;
  readonly parent: Id;
  readonly side: Side;
  readonly value: string;
}

export interface DeleteOp {
  readonly type: 'delete';
  readonly id: Id;
  readonly target: Id;
}

export type Operation = InsertOp | DeleteOp;

export type ApplyResult = 'applied' | 'duplicate' | 'missing-dependency';

/** buffered: waiting for a dependency or an earlier op from the same replica. stale: parent was compacted, caller must resync. */
export type ReceiveResult = 'applied' | 'duplicate' | 'buffered' | 'stale';

export interface SnapshotNode {
  readonly id: Id;
  readonly parent: Id;
  readonly side: Side;
  readonly value: string;
  readonly deletedBy: Id | null;
}

/** Serializable document state. Nodes are listed parent first. */
export interface DocumentSnapshot {
  readonly version: Record<string, number>;
  readonly nodes: SnapshotNode[];
  readonly pending: Operation[];
}
