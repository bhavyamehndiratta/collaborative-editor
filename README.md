# collaborative-editor

![CI](https://github.com/bhavyamehndiratta/collaborative-editor/actions/workflows/ci.yml/badge.svg)

A real-time collaborative code editor. Text sync runs on a sequence CRDT written from scratch (no Yjs, Automerge, ShareDB or OT libraries), served by Node.js WebSocket servers that scale out over Redis pub/sub and persist to PostgreSQL. The editor is CodeMirror 6 in a React client.

<!-- DEMO:START -->

<!-- DEMO:END -->

## What it does

- **CRDT core:** a Fugue style tree CRDT. Operations commute, are idempotent, and are causally buffered, so replicas converge regardless of delivery order. Concurrent runs of typing do not interleave. A blocked sequence index gives about a microsecond per operation at 100,000 characters.
- **Sync server:** rooms per document, snapshots plus an append only operation log, version vector catch-up for reconnecting clients, batched outbound messages with backpressure and slow consumer protection.
- **Horizontal scaling:** any instance serves any document. Instances fan out through Redis pub/sub, with Postgres as the source of truth and a resync from the log when Redis reconnects.
- **Presence:** remote cursors and selections anchored to element ids, so they follow the text through concurrent edits. Ephemeral, never persisted.
- **Offline editing:** the replica id, a snapshot and the queue of unacknowledged operations live in IndexedDB. A reload while offline keeps the edits, and reconnecting merges them with exponential backoff and jitter.
- **Testing:** property based tests over generated histories, integration tests against real Redis and PostgreSQL with two server instances, and benchmarks. CI runs on GitHub Actions with Redis and PostgreSQL service containers.

## Results

All numbers below are generated from the raw files in `bench/results` by `npm run readme`.

<!-- RESULTS:START -->
### Hardware

Apple M4, 10 cores, 16 GB RAM, darwin 24.5.0, Node v22.23.2. In the load test the two server processes, the load generator, Redis and PostgreSQL all ran on this one machine.

### CRDT micro benchmarks (100,000 characters, default block size)

| Operation | Time per operation |
| --- | --- |
| Local append (insert at the end) | 1.08 us |
| Local insert at a random position | 1.54 us |
| Local delete at a random position | 1.23 us |
| Remote apply, causal order | 1.06 us |
| Remote apply, reverse delivery order | 0.60 us |

Reading the full text takes 5.61 ms. Memory is 423.54 bytes of heap per character with random inserts (every character is its own node). Compacting after 50,000 deletes removed 22,640 of 100,000 nodes in 24.80 ms.

### Convergence testing

300,000 generated histories passed (3 properties, 10 seeds, 10,000 runs per property per seed). Each history is up to 80 commands across several replicas with reordered, duplicated and delayed delivery and replicas going offline. Seeds: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10.

### Load test (2 server instances, Redis fan-out, PostgreSQL)

Every editor types 2 operations per second for 20 seconds after a 3 second warmup. Editors alternate between the two instances. Latency is the time from an editor sending an operation to another editor's socket receiving it, in milliseconds (p50 / p95 / p99).

| Editors | Deliveries per second | Same instance | Across instances (via Redis) | Errors |
| --- | --- | --- | --- | --- |
| 10 | 180 | 13.18 / 14.67 / 15.02 | 13.79 / 15.08 / 15.44 | 0 |
| 50 | 4,890 | 12.51 / 14.25 / 14.99 | 12.72 / 14.53 / 15.35 | 0 |
| 100 | 19,764 | 12.41 / 15.33 / 16.48 | 12.77 / 15.64 / 17.23 | 0 |
| 200 | 79,586 | 12.05 / 16.75 / 18.84 | 12.42 / 17.07 / 19.41 | 0 |

About 10 ms of every figure is the server's deliberate 10 ms outbound batching window. The load generator's own event loop delay p99 stayed at or below 12.36 ms (the sampling resolution is 10 ms, so that is close to idle). Server memory after the 200 editor run was 116.94 MB and 112.92 MB resident.

Write throughput: 8 writers on separate documents, 20,000 operations each in batches of 500, waiting for the server's ack after every batch, persisted 128,524 operations per second (160,000 operations in 1.24 s, including snapshots). This is a short single run.

Limits of these numbers: one machine, synthetic append style edits rather than real typing patterns, and no network latency between clients and servers. They show how the server behaves under fan-out load, not what a deployed system would measure.
<!-- RESULTS:END -->

## Documentation

- [docs/design.md](docs/design.md): problem, requirements, why a CRDT, the algorithm, data structures, tombstones, protocol, persistence, scaling, offline, presence, testing, bugs found, limitations.
- [docs/architecture.md](docs/architecture.md): component and sequence diagrams (Mermaid) and failure behaviour.

## Run it

Requirements: Node 22, Redis and PostgreSQL running locally.

```bash
brew install redis postgresql@16
brew services start redis
brew services start postgresql@16
createdb collab

npm install
npm run server                       # builds, then listens on :8080
npm run dev -w @collab/client        # in a second terminal, serves http://localhost:5173
```

Open a document, copy the URL into a second window, and type in both.

To see two server instances fan out through Redis:

```bash
npm run build
PORT=8080 INSTANCE_ID=a node packages/server/dist/main.js
PORT=8081 INSTANCE_ID=b node packages/server/dist/main.js     # another terminal
npm run dev -w @collab/client                                 # talks to :8080
VITE_SERVER_URL=http://localhost:8081 npm run dev -w @collab/client -- --port 5174
```

Open the same document at `localhost:5173` and `localhost:5174`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 8080 | HTTP and WebSocket port |
| `DATABASE_URL` | `postgres://localhost:5432/collab` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `SNAPSHOT_EVERY` | 1000 | Operations between snapshots per document |
| `INSTANCE_ID` | `instance-<pid>` | Name shown by `/health` |

## Tests and benchmarks

```bash
npm test                 # unit, property (1,000 runs each) and integration tests
npm run test:property    # property suite at 10,000 runs per property
npm run test:sweep       # 10,000 runs per property under 10 seeds, saves bench/results
npm run bench:crdt       # CRDT micro benchmarks
npm run bench:load       # two server processes plus synthetic editors
npm run readme           # regenerate the results section from bench/results
```

The integration tests need Redis and PostgreSQL running. Any property failure reproduces with `PBT_SEED=<seed>`.

## Layout

```
packages/crdt        CRDT library: ids, tree, blocked sequence, version vectors, causal buffer, compaction
packages/protocol    message types and validation shared by client and server
packages/server      HTTP and WebSocket server, rooms, Postgres store, Redis bus
packages/client      React and CodeMirror 6 app, sync client, offline store
tests/property       fast-check suites
tests/integration    tests against real Redis and PostgreSQL
bench                micro benchmarks, load test, property sweep, raw results
docs                 design.md and architecture.md
```

## Known limitations

- Tombstone compaction exists in the library but the server does not use it, so documents only grow.
- Every character is a node (about 424 bytes of heap per character), with no run compression.
- Rooms are never unloaded and the operation log is never pruned.
- No periodic reconciliation between instances, and no authentication.

The full list is in section 15 of docs/design.md.
