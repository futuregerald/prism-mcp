/**
 * Tools whose handlers write to the storage backend (SQLite/Supabase rows,
 * not incidental filesystem side effects like an export or an IDE rules
 * file). Used by the idempotency layer in server.ts's CallTool handler:
 * only these tool names are eligible for `_meta["prism/idempotencyKey"]`
 * caching, so responses for read-only tools and image blobs are never
 * written to `prism_request_log`.
 *
 * See docs/plans/2026-09-24-prism-shared-daemon-handoff-phase2.md for the
 * per-tool reasoning behind this list.
 */
export const MUTATING_TOOLS: readonly string[] = [
  "session_save_ledger",
  "session_save_handoff",
  "session_compact_ledger",
  "session_backfill_embeddings",
  "session_backfill_links",
  "session_synthesize_edges",
  "session_cognitive_route",
  "memory_checkout",
  "session_save_image",
  "session_health_check",
  "session_forget_memory",
  "knowledge_forget",
  "knowledge_set_retention",
  "session_save_experience",
  "knowledge_upvote",
  "knowledge_downvote",
  "deep_storage_purge",
  "maintenance_vacuum",
  "agent_register",
  "agent_heartbeat",
  "session_start_pipeline",
  "session_abort_pipeline",
];
