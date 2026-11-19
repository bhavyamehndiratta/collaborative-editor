import type { DocumentSnapshot, Id, Operation } from '@collab/crdt';

export const MAX_OPS_PER_MESSAGE = 5000;
export const MAX_REPLICA_ID_LENGTH = 64;
export const MAX_NAME_LENGTH = 32;

export interface PresenceCursor {
  readonly anchor: Id;
  readonly head: Id;
}

export interface JoinMessage {
  readonly type: 'join';
  readonly docId: string;
  readonly replicaId: string;
  readonly version: Record<string, number>;
}

export interface OpsMessage {
  readonly type: 'ops';
  readonly docId: string;
  readonly ops: Operation[];
}

/** Client to server. Cursor ids are element ids (or the root id), never offsets. */
export interface PresenceMessage {
  readonly type: 'presence';
  readonly docId: string;
  readonly name: string;
  readonly color: string;
  readonly cursor: PresenceCursor | null;
}

export type ClientMessage = JoinMessage | OpsMessage | PresenceMessage;

export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly docId: string;
  readonly snapshot: DocumentSnapshot;
}

export interface AckMessage {
  readonly type: 'ack';
  readonly docId: string;
  readonly version: Record<string, number>;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly message: string;
}

/** Server to client: another replica's presence. */
export interface PresenceBroadcast {
  readonly type: 'presence';
  readonly docId: string;
  readonly replicaId: string;
  readonly name: string;
  readonly color: string;
  readonly cursor: PresenceCursor | null;
}

export interface PresenceLeaveMessage {
  readonly type: 'presenceLeave';
  readonly docId: string;
  readonly replicaId: string;
}

/** The server sends `ops` in the same shape clients do. */
export type ServerMessage =
  | SnapshotMessage
  | OpsMessage
  | AckMessage
  | ErrorMessage
  | PresenceBroadcast
  | PresenceLeaveMessage;

export type ParseResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isOpId(v: unknown): v is Id {
  return (
    isRecord(v) &&
    typeof v.replica === 'string' &&
    v.replica.length >= 1 &&
    v.replica.length <= MAX_REPLICA_ID_LENGTH &&
    typeof v.counter === 'number' &&
    Number.isSafeInteger(v.counter) &&
    v.counter >= 1
  );
}

/** A parent or anchor may be the virtual root (replica '', counter 0). */
function isRefId(v: unknown): v is Id {
  return isOpId(v) || (isRecord(v) && v.replica === '' && v.counter === 0);
}

function isOperation(v: unknown): v is Operation {
  if (!isRecord(v)) return false;
  if (v.type === 'insert') {
    return (
      isOpId(v.id) &&
      isRefId(v.parent) &&
      (v.side === 'L' || v.side === 'R') &&
      typeof v.value === 'string' &&
      v.value.length === 1
    );
  }
  if (v.type === 'delete') return isOpId(v.id) && isOpId(v.target);
  return false;
}

function isVersion(v: unknown): v is Record<string, number> {
  if (!isRecord(v)) return false;
  const entries = Object.entries(v);
  if (entries.length > 1000) return false;
  return entries.every(
    ([k, c]) =>
      k.length >= 1 &&
      k.length <= MAX_REPLICA_ID_LENGTH &&
      typeof c === 'number' &&
      Number.isSafeInteger(c) &&
      c >= 0,
  );
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}

export function parseClientMessage(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail('invalid JSON');
  }
  if (!isRecord(value)) return fail('message must be an object');
  if (!isUuid(value.docId)) return fail('docId must be a UUID');
  if (value.type === 'join') {
    const replicaId = value.replicaId;
    if (
      typeof replicaId !== 'string' ||
      replicaId.length < 1 ||
      replicaId.length > MAX_REPLICA_ID_LENGTH
    ) {
      return fail('invalid replicaId');
    }
    if (!isVersion(value.version)) return fail('invalid version vector');
    return {
      ok: true,
      message: { type: 'join', docId: value.docId, replicaId, version: value.version },
    };
  }
  if (value.type === 'ops') {
    const ops = value.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_MESSAGE) {
      return fail('ops must be a non empty array within the size limit');
    }
    if (!ops.every(isOperation)) return fail('invalid operation');
    return { ok: true, message: { type: 'ops', docId: value.docId, ops } };
  }
  if (value.type === 'presence') {
    const { name, color, cursor } = value;
    if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME_LENGTH) {
      return fail('invalid name');
    }
    if (typeof color !== 'string' || !COLOR.test(color)) return fail('invalid color');
    let parsedCursor: PresenceCursor | null = null;
    if (cursor !== null) {
      if (!isRecord(cursor) || !isRefId(cursor.anchor) || !isRefId(cursor.head)) {
        return fail('invalid cursor');
      }
      parsedCursor = { anchor: cursor.anchor, head: cursor.head };
    }
    return {
      ok: true,
      message: { type: 'presence', docId: value.docId, name, color, cursor: parsedCursor },
    };
  }
  return fail('unknown message type');
}
