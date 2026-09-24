# Shared daemon mode (experimental)

By default every MCP client session starts its own `node dist/server.js`. Each process loads the whole server: storage, scheduler and, when `embedding_provider=local`, its own copy of the ONNX embedding model. Ten sessions means ten copies.

Shared daemon mode runs **one** long-lived `prismd` process. Each session runs a small `prism-connect` shim instead. The old stdio mode is unchanged and remains the default.

```
 Claude session A ──stdio──▶ prism-connect ─┐
 Claude session B ──stdio──▶ prism-connect ─┼─ unix socket ─▶ prismd ──▶ data.db, prism-config.db
 Claude session C ──stdio──▶ prism-connect ─┘   (0600)         │         embedding model (one copy)
                                                              └─ scheduler, job worker (one copy)
```

## Measured

These numbers are for a 400 MB database with `embedding_provider=local`, using `footprint` physical memory on macOS:

| | stdio (before) | shared daemon |
|---|---|---|
| Memory, 2 sessions | 2,470 MB | (not measured) |
| Memory, 8 sessions | ~9,900 MB (extrapolated from 2) | 1,982 MB (1,838 daemon + 8 × 18) |
| Memory, 12 real long-running sessions | 19,084 MB (measured on a live machine) | ~2,050 MB (estimated: daemon + 12 × 18) |
| Per extra session | 0.75–1.7 GB | 18 MB |
| `session_load_context` | 4.9 s | 0.8–2.5 s |
| Daemon SIGKILL to next successful call | n/a | ~1.7–2.1 s |

Chaos test: 3 sessions made 600 saves while the daemon was SIGKILLed 64 times. Every save was acknowledged, none was lost or duplicated, and there was never more than one daemon.

## How it works

- **Starting.** The shim connects to `$PRISM_DATA_DIR/prismd.sock`. If nothing is listening, it spawns `dist/daemon.js` detached. Exactly one shim spawns per dead daemon: the spawn is claimed with `O_EXCL`, keyed on the dead daemon's lock identity.
- **One daemon.** `prismd.lock` plus the socket form the lock. A live lock PID is waited on, never broken. A dead or reused PID is broken after 3 s. A daemon only ever unlinks a socket whose inode it created.
- **Reconnect.** If the daemon dies, the shim reconnects with backoff (50 ms up to 250 ms). It replays the client's `initialize` and resends every in-flight request. Cancelled requests are dropped.
- **No double writes.** For state-changing tools, the shim tags each call with `_meta["prism/idempotencyKey"]`. The daemon honours a key only when it carries the connection's own client id. It claims a `pending` row before running the tool, and returns the stored response on a replay.
  - `session_save_ledger` derives its row id from the key, so it is exactly-once even across a crash.
  - A small window remains for other tools: the daemon dies after the tool commits but before the request log is marked done. Those tools are at-least-once.
- **Writes hit disk.** SQLite runs with `synchronous=FULL`. The access log is write-through. Embeddings go through a durable `prism_jobs` queue instead of fire-and-forget promises. A job enqueued before the tool returns survives a crash, and the worker re-queues ledger rows that have no embedding.
- **Shutdown.** SIGTERM, idle exit (30 min with no connections) or `prism-daemon restart` all shut down the same way:
  1. unlink our socket and refuse new tool calls;
  2. drain in-flight calls (up to 10 s);
  3. stop the job worker;
  4. close the databases.

## Trying it

```bash
npm run build
PRISM_DATA_DIR=$(mktemp -d)/.prism-mcp node dist/shim.js
```

To point an MCP client at it, use the shim as the stdio command:

```json
{ "type": "stdio", "command": "node", "args": ["/path/to/prism-mcp/dist/shim.js"] }
```

Other commands:
- `node dist/daemon.js restart` asks the running daemon to shut down; the next shim call respawns it.
- `node dist/daemon.js prune-zero-sdm` deletes `sdm_state` rows whose counters are all zero. It is never run automatically. On one real database this was 351 MB of the 400 MB file.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PRISM_DATA_DIR` | `~/.prism-mcp` | data directory (must be owned by the user and not a symlink; tightened to 0700) |
| `PRISM_SOCKET` | `$PRISM_DATA_DIR/prismd.sock` | socket path (macOS limit: 104 bytes) |
| `PRISM_DAEMON_IDLE_EXIT_MS` | `1800000` | idle exit with zero connections; `0` means never |
| `PRISM_SHIM_REQUEST_TIMEOUT_MS` | `120000` | in-flight requests fail with `-32000` after this long without a daemon |
| `PRISM_SHIM_DEBUG` | unset | `1` logs the shim's activity to stderr |

## Limits

- The daemon inherits the environment of the shim that spawned it. Settings changed later (dashboard settings, provider keys) take effect after `prism-daemon restart`.
- The deferred auto-push of context at startup is stdio-only.
- Supabase mode is untested with the daemon. The idempotency and job-queue storage methods are no-ops there.
- The daemon's memory is mostly the embedding model (~650 MB) plus the peak working memory of embedding long texts, which the allocator keeps. Running embeddings in a child process that exits when idle would bring an idle daemon down to about 300 MB.

## Rollback

Point the MCP client back at `dist/server.js`. The new tables (`prism_request_log`, `prism_jobs`) are additive and ignored by stdio mode.
