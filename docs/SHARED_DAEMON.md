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
- **One daemon.** `prismd.lock` plus the socket form the lock. A live lock PID is waited on for up to 30 s; the lock is only broken if the socket still refuses a connection after that wait (re-probed once, right before breaking it). A dead PID's lock is broken after 3 s. A PID that returns `EPERM` (owned by another user) is treated as dead. A daemon only ever unlinks a socket whose inode it created.
- **`PRISM_SOCKET`.** If set, its parent directory must be owned by the current user and not group- or world-writable. Otherwise the daemon refuses to start (exits non-zero) and the shim answers every request with a JSON-RPC error instead of connecting.
- **Config fingerprint.** Each shim sends a hash of `PRISM_USER_ID`/`PRISM_STORAGE`/`SUPABASE_URL` in its hello. A daemon running with a different fingerprint refuses the connection; the shim then answers all pending and future requests with `-32001` until the environment is aligned or the daemon is restarted. A hello with no fingerprint (older shim) is always accepted.
- **Reconnect.** If the daemon dies, the shim reconnects with backoff (50 ms up to 250 ms). It replays the client's `initialize`, every in-flight request, and any active `resources/subscribe` / `logging/setLevel` state. Cancelled requests are dropped.
- **Crash-loop limit.** A request that would be sent to the daemon a 3rd time (survived 2 daemon deaths without a response) is failed with `-32002` instead of being retried again.
- **Spawn backoff.** If the daemon keeps failing to start, the shim backs off exponentially (1 s, 2 s, 4 s … capped at 30 s) between spawn attempts, resetting once a connection completes the hello. After 3 consecutive spawns that never produce a listening socket, pending requests are failed with `-32003` naming the daemon's log file; the shim keeps retrying in the background.
- **No double writes.** For state-changing tools, the shim tags each call with `_meta["prism/idempotencyKey"]`. The daemon honours a key only when it carries the connection's own client id. It claims a `pending` row before running the tool, and returns the stored response on a replay.
  - `session_save_ledger` derives its row id from the key, so it is exactly-once even across a crash.
  - A small window remains for other tools: the daemon dies after the tool commits but before the request log is marked done. Those tools are at-least-once.
- **Writes hit disk.** SQLite runs with `synchronous=FULL`. The access log is write-through. Embeddings go through a durable `prism_jobs` queue instead of fire-and-forget promises. A job enqueued before the tool returns survives a crash, and the worker re-queues ledger rows that have no embedding. Stdio mode (`dist/server.js`) runs the same durable job worker and request-log retention as the daemon, not just shared daemon mode.
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
| `PRISM_DATA_DIR` | `~/.prism-mcp` | data directory; symlinks are resolved and the resolved directory must be owned by the user, tightened to 0700 |
| `PRISM_SOCKET` | `$PRISM_DATA_DIR/prismd.sock` | socket path (macOS limit: 104 bytes); its parent directory must be owned by the user and not group/world-writable, or the daemon/shim refuse to start |
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
