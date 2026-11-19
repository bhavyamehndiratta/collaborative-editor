# Design: Real-Time Collaborative Code Editor with CRDT Sync

Status: draft for review (Stage 1). No code exists yet. Sections marked "to be filled" are completed by later stages with real results.

## 1. Problem

Several people edit the same source file at once, in the browser. Each person must see their own keystrokes instantly, see other people's edits and cursors within a fraction of a second, keep editing while offline, and always end up with identical text once everyone has synced. The service must survive a server restart and run as more than one server instance.

## 2. Requirements

### Functional
- Create, list, and open documents.
- Concurrent editing with live remote cursors and selections (name and color per user).
- Offline editing: local operations are queued in the browser and merged on reconnect.
- Connection status shown to the user: online, offline, syncing.

### Correctness
- **Strong eventual consistency (SEC):** any two replicas that have received the same set of operations show identical text, regardless of delivery order.
- **Idempotence:** receiving an operation twice has no further effect.
- **Causality:** an operation is applied only after the operations it depends on.
- **Intention preservation:** a user's own insertions keep their relative order, and concurrent runs of text from different users are not interleaved (see section 4.4 for the exact guarantee).

### Non-functional
- Local edits apply with no network round trip.
- Sync latency (one client's edit appearing on another) measured as p95 and p99, including across server instances.
- Insert, delete, and position lookup in O(log n) on large documents (100k+ characters).
- 2 or more stateless server instances behind any load balancer, coordinated through Redis.
- Documents are durable in PostgreSQL and recoverable after a restart.

### Out of scope
- Authentication and access control beyond a display name.
- Rich text, multi-file projects, undo across users.
- Byzantine (malicious) replicas.

## 3. Why a CRDT and not operational transformation

**Operational transformation (OT)** sends position based operations ("insert 'x' at index 5") and rewrites concurrent operations against each other so they still make sense. Correct OT for arbitrary peers needs transformation functions that satisfy properties (TP1 and TP2) that are notoriously hard to get right; several published algorithms were later shown to be wrong. Production OT systems (Google Docs, ShareDB) avoid that by routing every operation through one central server that defines a single total order. That server is then on the critical path for every edit, and offline editing means transforming a long local history against a long remote history on reconnect.

**A CRDT** gives every character a unique, immutable identity and defines operations relative to those identities, not to indices. Concurrent operations commute by construction, so no transformation is needed and no central ordering authority is required. Any replica can apply any operation as soon as its dependencies are present.

What each needs from the server:

| | OT (central server) | CRDT (this project) |
|---|---|---|
| Server role | Defines the total order, transforms ops | Relay, persistence, catch-up only |
| Server must understand ops | Yes | No (stores and forwards bytes; it does run the CRDT to build snapshots) |
| Offline editing | Hard: transform long histories | Natural: ops merge in any order |
| Multi-instance server | Needs a single sequencer per document | Any instance can accept any op |
| Cost | Small operations, no metadata per char | Per character metadata and tombstones |

The CRDT's costs (metadata and tombstones) are addressed by the data structure in section 5 and the compaction strategy in section 6.

## 4. CRDT algorithm

### 4.1 Options considered

| Algorithm | Ordering of concurrent inserts | Interleaving | Identifier size | Tombstones | Notes |
|---|---|---|---|---|---|
| RGA | Insert after a left neighbour; ties by ID | Interleaves in some cases (for example two users typing backwards at the same spot) | Fixed | Yes | Simple, well studied |
| YATA (Yjs) | Left and right origins with an integration rule | Better than RGA, not fully avoided | Fixed | Yes | Subtle integration rule; would read as a Yjs reimplementation |
| Logoot / LSEQ | Dense fractional position identifiers | Worst: concurrent words can interleave character by character | Grows without bound | No (true removal) | Bad fit for code |
| **Fugue** | Tree of left and right children; in-order traversal | **Maximally non-interleaving (proved)** | Fixed | Yes | Weidner and Kleppmann, 2023 |

**Decision: Fugue.** It is the only option with a proof that it avoids interleaving, its rules are short enough to test exhaustively, and its costs (fixed size IDs plus tombstones) match RGA's.

### 4.2 Identifiers

Every operation has an ID `(replicaId, counter)`.
- `replicaId`: random string created once per browser profile (stored in IndexedDB) and once per server process.
- `counter`: incremented by one for every operation the replica creates, so each replica's operations form a gap free sequence 1, 2, 3, and so on.

IDs are totally ordered by `(replicaId, counter)` to break ties deterministically. Because counters per replica have no gaps, the set of operations a replica has seen is summarized exactly by a **version vector**: a map from `replicaId` to the highest counter seen.

### 4.3 Structure and operations

The document is a tree. Each node holds one character (or a run, see section 5), its ID, a `parent` ID, a `side` (left or right), and a `deleted` flag. A virtual root sits at the top. **The text is the in-order traversal of the tree, skipping deleted nodes.**

**Local insert** of character `c` at visible index `i`:
1. Let `L` be the node immediately before the insertion point in the full sequence (including tombstones), or the root.
2. If `L` has no right children, the new node becomes a **right child of L**.
3. Otherwise let `R` be the node immediately after `L` in the full sequence; the new node becomes a **left child of R** (`R` has no left children by construction).
4. Emit `Insert { id, parent, side, char }`.

**Local delete** of the character at visible index `i`: find its node, set `deleted = true`, emit `Delete { id, target }`.

**Remote apply**:
- `Insert`: attach the node under `parent` on `side`. Siblings on the same side are ordered by a fixed total order on IDs. The exact sibling ordering rule is taken from the Fugue paper and pinned down with unit tests in Stage 3.
- `Delete`: set `deleted = true` on `target`.
- If the op's ID is already known, do nothing (**idempotence**).
- If `parent` (for an insert) or `target` (for a delete) is not yet known, buffer the op (section 4.5).

**Why it converges:** a node's position depends only on its own immutable `(parent, side, id)` fields, never on when it arrived. Every replica that holds the same set of nodes builds the same tree and therefore the same traversal. Deletion is a flag that only goes from false to true, so delete order does not matter either.

### 4.4 Interleaving and intention preservation

**Interleaving** is when two users type words concurrently at the same spot and the merged result mixes their characters ("Hhelilo" instead of "Hello" + "hi"). Each character a user types continues their own chain in the tree (right children when typing forwards, left children when typing backwards), so concurrent runs stay in separate subtrees and are emitted contiguously by the traversal.

Guaranteed:
- Each user's own insertions keep their relative order.
- Concurrent runs typed forwards or backwards at the same position are not interleaved (the paper's maximal non-interleaving property).

Not guaranteed (documented limitations):
- Which of two concurrent runs comes first is arbitrary but deterministic (ID order), not semantic.
- No move operation: cut and paste is a delete plus an insert, so concurrent edits inside moved text stay at the old location.
- Concurrent edits that are each valid can still produce code that does not compile. The CRDT guarantees identical text, not meaningful text.

### 4.5 Causal delivery

An `Insert` depends on its `parent`; a `Delete` depends on its `target`. If a dependency is missing, the op goes into a buffer keyed by the missing ID. When that ID arrives, its waiting ops are retried, recursively. This removes any need for the network or server to guarantee causal order.

The buffer is bounded per document. If it overflows (which means a replica missed operations), the replica requests a catch-up from the server with its version vector (section 7.3).

## 5. Data structures and complexity

A naive implementation walks the whole tree to turn a visible index into a node, which is O(n) per keystroke. The implementation uses two indexes:

1. **ID map:** a hash map from operation ID to node. O(1) lookup for applying remote operations and for resolving presence anchors.
2. **Blocked sequence:** the nodes in document order (tombstones included), stored as blocks of at most 512 nodes, each block caching its count of visible characters. Converting a visible index to a node scans the per-block counts and then the block, so it costs O(n/B + B) with B = 512 (about 200 blocks for 100,000 characters). Inserting next to a known node is O(B) because every node knows its block. A full text read is O(n).

The sequence mirrors the in-order traversal of the Fugue tree. `verifyStructure()` rebuilds the traversal from the tree and compares it with the sequence, and the property suite calls it after every history with a block size of 4, so block splits happen constantly.

**Why not a balanced tree:** an order statistic B-tree gives O(log n) index conversion, but the measured cost is already about one microsecond per operation at 100,000 characters (table below), so the extra complexity was not justified. A tree is the upgrade path if documents reach millions of characters.

**No run compression:** every character is its own node. An earlier plan stored consecutive characters from one replica as a single run; it was not built. The cost is about 424 bytes of heap per character for random inserts. Run compression is the main memory optimization left.

| Operation | Complexity | Measured at 100,000 characters |
|---|---|---|
| Local insert at index | O(n/B + B) plus placement | 1.08 us appending, 1.55 us at random positions |
| Local delete at index | O(n/B + B) | 1.23 us |
| Remote insert (known parent) | O(n/B + B) plus sibling and subtree scan | 1.07 us in order, 0.60 us in reverse order |
| Remote delete | O(1) lookup plus a block count update | not measured separately |
| Full text read | O(n) | 5.6 ms |

Measured on an Apple M4 (10 cores, 16 GB) with Node 22.23.2. Raw results are in `bench/results/crdt-micro-*.json`, produced by `npm run bench:crdt`.

## 6. Tombstones and garbage collection

**Why tombstones:** a deleted character may still be the `parent` of an insert that some replica created concurrently and has not delivered yet. If the node were removed, that insert could not be placed.

**When removal is safe:** a tombstone can be removed once every replica that could still send operations has seen the delete, so no future operation can name it as a parent. Version vectors express this: `compact(stable)` removes a tombstone only if the stable version vector covers its delete and the node is a leaf, so removing it cannot change the traversal. Removal cascades: a parent that becomes a leaf tombstone is removed in the same pass.

**Implemented:** `CrdtDocument.compact(stableVersion)` in the library. An operation that arrives later and references a removed node returns `stale` instead of being applied, and the sending replica must resync from a snapshot. A property test compacts at a stable version and then keeps editing, and checks that all replicas still converge.

**Measured:** with 100,000 nodes and 50,000 random deletes, compaction removed 22,640 nodes (22.6 percent) in 24.8 ms. Only leaf tombstones can go, so the rest stay while they have descendants. Process heap before and after was 230.3 MB and 220.9 MB, but that is one reading of the heap, not an isolated measurement, so treat it as indicative.

**Not implemented:** use on the server. Compaction is only safe when the set of replicas is known and their version vectors are tracked. Browser tabs are anonymous and short lived, so the server does not compact, and tombstones accumulate. The design, if it were built: the server records the latest version vector of every replica seen in the last N days, takes the pointwise minimum as the stable version, compacts while snapshotting, and tells a replica that returns after being dropped to discard its local state and resync.

## 7. Sync protocol

Transport: WebSocket, JSON messages, types shared in `packages/protocol`.

### 7.1 Messages (client to server)
- `join { docId, replicaId, versionVector }`
- `ops { docId, ops[] }` (batched)
- `presence { docId, cursor, selection }`

### 7.2 Messages (server to client)
- `snapshot { docId, state, versionVector }` (new client)
- `ops { docId, ops[] }` (catch-up or live)
- `ack { docId, versionVector }`
- `presence { docId, replicaId, name, color, cursor, selection }`
- `presenceLeave { docId, replicaId }`

### 7.3 Join and catch-up
1. Client sends `join` with its version vector (empty for a new client).
2. Empty vector: server sends the latest snapshot plus ops after it.
3. Otherwise: server sends only ops whose counter is above the client's vector entry for that replica. This is how a reconnecting client receives only what it missed.
4. Client then sends its queued offline ops; the server persists, acks, and fans them out.

### 7.4 Batching and backpressure
- **Client:** local ops are coalesced in a ~30 ms window (or up to a size cap) and sent as one `ops` message. Consecutive keystrokes usually merge into a single run.
- **Server:** before writing to a socket, the server checks `bufferedAmount`. Above a threshold, outgoing ops for that client are coalesced into a pending batch instead of being queued message by message; above a hard limit, the client is disconnected and recovers through catch-up. Memory per slow client stays bounded.

## 8. Persistence and recovery

PostgreSQL tables (final columns settled in Stage 7):
- `documents (id, name, created_at)`
- `operations (doc_id, replica_id, counter, payload, received_at)`, primary key `(doc_id, replica_id, counter)`. The primary key makes persistence idempotent: a duplicate insert is ignored.
- `snapshots (doc_id, version_vector, state, created_at)`

Write path: an op is appended to `operations` before it is acked. Every N ops (for example 1,000) the server writes a snapshot, compacting stable tombstones.

Recovery: on first access after a restart, load the latest snapshot and replay operations not covered by its version vector. This is the event sourcing pattern: the log is the source of truth, snapshots only speed up loading.

## 9. Horizontal scaling with Redis pub/sub

- Any instance can serve any document; there is no document ownership.
- Each document has a Redis channel `collab:doc:<docId>`. An instance subscribes when it first loads the document's room, before it reads the log, so no operation can fall between the snapshot read and the subscription. Subscriptions are not released today because rooms are not unloaded.
- When an instance receives operations from a client it persists them idempotently, applies them to its in-memory copy, forwards them to its own clients, and publishes only the operations that were new to Postgres. Every message carries the sending instance's id and an instance ignores its own messages.
- Receiving instances apply operations through the same causal buffer as any replica, so reordering between two publishers is harmless, and duplicates are ignored because application is idempotent.
- Presence uses the same channel with separate message types and is never written to Postgres. When a client joins, its instance publishes a sync request and every instance republishes the presence of its local clients, so late joiners see existing cursors.

**If Redis goes down:** Postgres stays the source of truth, so no edit is lost. Clients on the same instance keep syncing with each other. Clients on different instances stop seeing each other's edits until the subscriber reconnects. Then every loaded room pulls what it lacks from Postgres (all logged operations not covered by the room's version vector) and forwards them to its clients.

**Known gap:** there is no periodic reconciliation. If only a publish fails while the subscriber stays connected, the other instances do not learn about those operations until their next resync.

## 10. Offline editing

- The client persists three things per document in IndexedDB: its replica id, a snapshot of its CRDT state, and the queue of operations the server has not acknowledged. Writes are debounced by 100 ms and flushed when the page hides or the client stops, so a hard crash can lose at most the last 100 ms of typing.
- Reopening a document that has saved state shows it immediately, even with the server down, and keeps the same replica id so operation counters continue where they stopped.
- The client applies its own operations immediately; the UI never waits for the network.
- Reconnect uses exponential backoff with jitter, starting at 0.5 s and doubling to a 30 s cap.
- On reconnect the client joins with its local version vector, receives the operations it missed, and resends its queue. The server stores operations idempotently, so resending something it already has is harmless, and because operations commute the order of the two flows does not matter.
- Queue entries are removed only after the server's `ack` covers them.

## 11. Presence

- Cursor and selection positions are sent as **element IDs** (the ID of the character the cursor sits after, plus the selection anchor), not as integer offsets. An offset goes stale the moment someone else inserts text earlier in the document; an element ID keeps pointing at the same character, and the receiver converts it to an index in O(log n). If the anchor character is deleted, the cursor moves to its nearest visible predecessor (tombstones keep the node findable).
- Presence is **ephemeral**: it only matters while the user is connected, it changes on every keystroke, and logging it would bloat the operation log and replay. It is sent through WebSocket and Redis only, throttled (for example every 50 ms), and dropped when the user disconnects.

## 12. Client

- React + TypeScript, built with Vite.
- **Editor: CodeMirror 6.** Its transactions describe edits as change sets (ranges inserted and deleted), which map directly to CRDT inserts and deletes, and remote changes can be dispatched back as transactions. It has a small footprint and decorations for remote cursors. Monaco is heavier, built around VS Code's own model, and harder to bind to an external data model cleanly.
- Screens: document list, editor with remote cursors, connection status indicator.

## 13. Testing strategy

- **Unit tests (Vitest):** ID ordering, insert placement rules, delete, idempotence, the causal buffer, version vectors, anchors, snapshots and compaction.
- **Property-based tests (fast-check):** three properties over generated histories of 1 to 80 commands on several replicas (insert, delete, deliver in random order, duplicate, go offline, come back). (1) Convergence, idempotence, commutativity, per user intention and structure consistency. (2) Concurrent runs of text from different replicas do not interleave. (3) Compacting at a stable version and then continuing to edit still converges. `npm test` runs 1,000 histories per property and `npm run test:property` runs 10,000. `npm run test:sweep` runs 10,000 per property under 10 fixed seeds, which is 300,000 histories, and saves the result to `bench/results/property-sweep.json`. Any failure reproduces from its seed (`PBT_SEED`) and is shrunk to a minimal history.
- **Mutation check:** breaking the sibling ordering rule on purpose makes the property suite fail, which shows the suite is sensitive to that class of bug.
- **Integration tests against real Postgres and Redis:** the server (join, operations, spoofed replica rejected, restart recovery with snapshots), the sync client (reconnect, edits merged after being offline), presence, a reload while offline, and two server instances (cross instance delivery, presence, concurrent writes through both, and recovery on a fresh third instance).
- **CI:** GitHub Actions with Redis and Postgres service containers runs build, lint and all tests on every push.

## 14. Bugs found along the way

This list says how each problem was found, because only some were found by the tests.

1. **Offline operations dropped in the property harness (found by the property suite).** A dangling `else` in the harness's broadcast helper silently dropped operations produced while a simulated replica was offline, so replicas appeared to diverge. The suite flagged it on its first full run. The root cause was in the test code, not the CRDT, and the fix was braces around the branch.
2. **Wrong expectation in a causal buffering test (found by the unit tests).** A test expected `duplicate` for an operation that had never been delivered to that replica, where `applied` is correct. Fixed in the test.
3. **Can the suite detect real bugs? (mutation check).** Breaking the sibling ordering rule on purpose made the property suite fail, and restoring it made it pass again. After that, 300,000 generated histories across 10 seeds found no convergence failure in the CRDT itself.
4. **Snapshot recovery with several writers (found by design review, covered by an integration test).** Recovery first replayed the log after the snapshot's `last_seq`. With two instances writing, sequence numbers are not commit order, so a late committing operation with a lower sequence number could be skipped for good. Recovery and resync now replay every logged operation that the version vector does not cover. The multi instance test recovers a document from snapshots written by two interleaving instances.
5. **Remote cursors never drawn (found by hand).** The page replaced the editor binding's presence handler right after creating it, so cursors were received but never redrawn. There is no automated browser test for rendering, so this was found by opening two windows.

## 15. Limitations

- Tombstone compaction exists in the library but the server does not use it (section 6), so documents only grow.
- Memory is about 424 bytes per character for random inserts (measured). Run compression would cut it.
- Rooms are never unloaded from a server instance, and the operation log is never pruned.
- There is no periodic reconciliation between instances (section 9). The presence of a crashed instance's clients stays visible until those editors reconnect elsewhere.
- Snapshots serialize the whole document every 1,000 operations, so snapshot cost grows with document size.
- The offline queue is written 100 ms after a change, so a hard crash can lose the last 100 ms of typing.
- No move operation; concurrent edits inside moved text are not carried with it.
- Concurrent run order is deterministic but arbitrary.
- No authentication or authorization.
- JSON on the wire is simple but larger than a binary encoding.

## 16. What would change at larger scale

- **100x users:** shard documents across instances (consistent hashing on `docId`) so each document's subscribers concentrate on fewer instances; replace fire and forget pub/sub with Redis Streams or Kafka for replayable fan-out; move snapshots to object storage.
- **Millions of characters:** binary encoding of ops and snapshots; lazy loading of the tree by region; more aggressive run merging; server side compaction on a background worker instead of inline.
- **Large edit bursts (paste, find and replace):** send ranges as single run ops; this is already supported by the run representation.
