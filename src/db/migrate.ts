import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db, client } from "./index";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  enabled INTEGER NOT NULL DEFAULT 1,
  tokens TEXT,
  quota_limit REAL DEFAULT 0,
  quota_remaining REAL DEFAULT 0,
  quota_reset_at INTEGER,
  free_limit REAL DEFAULT 0,
  free_remaining REAL DEFAULT 0,
  free_reset_at INTEGER,
  last_used_at INTEGER,
  last_login_at INTEGER,
  error_message TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_email_idx ON accounts (provider, email);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id),
  provider TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  credits_used REAL DEFAULT 0,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error_message TEXT,
  request_body TEXT,
  response_body TEXT,
  account_email TEXT,
  account_quota_before REAL DEFAULT 0,
  account_quota_after REAL DEFAULT 0,
  compression_stats TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs (created_at);
CREATE INDEX IF NOT EXISTS request_logs_status_created_at_idx ON request_logs (status, created_at);
CREATE INDEX IF NOT EXISTS request_logs_provider_created_at_idx ON request_logs (provider, created_at);
CREATE INDEX IF NOT EXISTS request_logs_provider_model_status_idx ON request_logs (provider, model, status);
CREATE INDEX IF NOT EXISTS request_logs_account_idx ON request_logs (account_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  total_requests INTEGER DEFAULT 0,
  success_requests INTEGER DEFAULT 0,
  error_requests INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  credits_used REAL DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_summary_bucket_provider_model_idx ON usage_summary (bucket, provider, model);
CREATE INDEX IF NOT EXISTS usage_summary_bucket_idx ON usage_summary (bucket);
CREATE INDEX IF NOT EXISTS usage_summary_provider_idx ON usage_summary (provider, bucket);

CREATE TABLE IF NOT EXISTS image_studio_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  messages TEXT NOT NULL,
  final_prompt TEXT,
  options TEXT,
  assist_model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS image_studio_chats_updated_at_idx ON image_studio_chats (updated_at);

CREATE TABLE IF NOT EXISTS image_studio_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER REFERENCES image_studio_chats(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'image',
  aspect_ratio TEXT NOT NULL DEFAULT '1:1',
  n INTEGER NOT NULL DEFAULT 1,
  urls TEXT NOT NULL,
  credits_used REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS image_studio_results_created_at_idx ON image_studio_results (created_at);
CREATE INDEX IF NOT EXISTS image_studio_results_chat_idx ON image_studio_results (chat_id);

CREATE TABLE IF NOT EXISTS filter_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,
  pattern TEXT NOT NULL,
  replacement TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_regex INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS filter_rules_sort_order_idx ON filter_rules (sort_order);

CREATE TABLE IF NOT EXISTS proxy_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'http',
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at INTEGER,
  last_checked_at INTEGER,
  error_message TEXT,
  latency_ms INTEGER,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS proxy_pool_status_idx ON proxy_pool (status);

CREATE TABLE IF NOT EXISTS model_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_pattern TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',
  target_model TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS model_mappings_priority_idx ON model_mappings (priority);
`;

/**
 * Idempotent column-add migrations.
 * The drizzle/ folder is gitignored in this repo — fresh deploys would never
 * see file-based migrations for new columns. Each entry below adds a column
 * if it doesn't already exist; safe to run on every boot.
 *
 * Order: from oldest schema additions to newest. Add to the END of the list
 * when you add a new column to schema.ts.
 */
const IDEMPOTENT_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // 2026-06-13 — compression_stats (token-saver telemetry, see src/proxy/compression/)
  { table: "request_logs", column: "compression_stats", ddl: "ALTER TABLE request_logs ADD COLUMN compression_stats TEXT" },
  // 2026-06-14 — Qoder Free counter (mirrors /activity qmodel_latest promo).
  // Decremented per-request when the model maps to qmodel_latest. Synced from
  // Qoder by the quota-sync runner. See src/proxy/providers/qoder.ts.
  { table: "accounts", column: "free_limit",     ddl: "ALTER TABLE accounts ADD COLUMN free_limit REAL DEFAULT 0" },
  { table: "accounts", column: "free_remaining", ddl: "ALTER TABLE accounts ADD COLUMN free_remaining REAL DEFAULT 0" },
  { table: "accounts", column: "free_reset_at",  ddl: "ALTER TABLE accounts ADD COLUMN free_reset_at INTEGER" },
];

function tableHasColumn(table: string, column: string): boolean {
  try {
    const rows = client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function runIdempotentColumns() {
  for (const m of IDEMPOTENT_COLUMNS) {
    if (tableHasColumn(m.table, m.column)) continue;
    try {
      await db.run(sql.raw(m.ddl));
      console.log(`[DB] Added column ${m.table}.${m.column}`);
    } catch (err) {
      // Re-check: another process may have added it concurrently.
      if (!tableHasColumn(m.table, m.column)) {
        console.error(`[DB] Failed to add ${m.table}.${m.column}:`, err);
      }
    }
  }
}

function initializeBaseSchema() {
  client.exec(BASE_SCHEMA);
}

export async function runMigrations() {
  const migrationsFolder = "./drizzle";

  // Only run file-based migrations if the folder exists
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    console.log("[DB] Running migrations...");
    await migrate(db, { migrationsFolder });
    console.log("[DB] Migrations complete.");
  } else {
    console.log("[DB] No migrations found; ensuring base schema.");
  }

  initializeBaseSchema();

  // Always run idempotent column-add migrations (works on fresh deploys without drizzle/).
  await runIdempotentColumns();
}

// Run if called directly
if (import.meta.main) {
  await runMigrations();
  console.log("[DB] Database migrated successfully");
  process.exit(0);
}
