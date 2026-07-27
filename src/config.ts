import path from "path";

const projectRoot = path.resolve(import.meta.dir, "..");

export const config = {
  port: Number(process.env.PORT) || 1930,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1931,
  apiKey: process.env.API_KEY || "pool-proxy-secret-key",
  databasePath: process.env.DATABASE_PATH || path.join(projectRoot, "data/omniark.db"),
  encryptionKey:
    process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  logBodyEnabled: process.env.OMNIARK_LOG_BODY_ENABLED !== "false",
  logBodyFull: process.env.OMNIARK_LOG_BODY_FULL !== "false",
  logBodyRedact: process.env.OMNIARK_LOG_BODY_REDACT === "true",
  logBodyMaxBytes: Number(process.env.OMNIARK_LOG_BODY_MAX_BYTES) || 65536,
  accountCacheTtlMs: Number(process.env.OMNIARK_ACCOUNT_CACHE_TTL_MS) || 3000,
  providerRequestTimeoutMs: Number(process.env.OMNIARK_PROVIDER_REQUEST_TIMEOUT_MS) || 120_000,
  providerQuotaTimeoutMs: Number(process.env.OMNIARK_PROVIDER_QUOTA_TIMEOUT_MS) || 15_000,
  // Providers: kiro, kiro-pro, codex, qoder
  providers: ["kiro", "kiro-pro", "codex", "qoder"] as const,
} as const;

export type Config = typeof config;
export type Provider = (typeof config.providers)[number];
