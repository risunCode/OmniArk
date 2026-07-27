import { Hono } from "hono";
import { db } from "../../db/index";
import { accounts, requestLogs } from "../../db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";
import type { NewAccount } from "../../db/schema";
import { pool, type ProviderName } from "../../proxy/pool";
import { activateQoderPat } from "../../proxy/providers/qoder/index";
import { registerByokRoutes } from "./byok";
import { handleCodexInstantLogin } from "./codex";

export const accountsRouter = new Hono();

export {
  decodeJwtPayload,
  exchangeCodexAuthorizationCode,
  exchangeCodexRefreshTokens,
  importCodexAccessToken,
} from "./codex";

/**
 * GET /api/accounts - List all accounts
 */
accountsRouter.get("/", async (c) => {
  const allAccounts = await db.select().from(accounts);

  // Don't expose passwords in response
  const sanitized = allAccounts.map((acc) => ({
    ...acc,
    password: "***",
    tokens: acc.tokens ? "[set]" : null,
  }));

  return c.json({ data: sanitized, total: sanitized.length });
});

// Register BYOK routes before dynamic /:id routes to preserve precedence
registerByokRoutes(accountsRouter);

/**
 * GET /api/accounts/:id - Get single account
 */
accountsRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  return c.json({
    ...account,
    password: "***",
    tokens: account.tokens ? "[set]" : null,
  });
});

/**
 * POST /api/accounts - Create new account
 */
accountsRouter.post("/", async (c) => {
  const body = await c.req.json<{
    provider: "codex" | "qoder";
    email?: string;
    password?: string;
    personalToken?: string;
    tokens?: Record<string, unknown>;
    status?: "active" | "pending";
  }>();

  if (!body.provider) {
    return c.json({ error: "provider is required" }, 400);
  }

  if (body.provider === "qoder" && body.personalToken) {
    const trimmed = body.personalToken.trim();
    if (!trimmed) return c.json({ error: "personalToken is empty" }, 400);

    try {
      const { tokens, jobToken } = await activateQoderPat(trimmed);
      const email = jobToken.email || jobToken.name || `qoder-${tokens.userId || Date.now()}@pat`;

      const existing = await db.select().from(accounts)
        .where(eq(accounts.email, email))
        .then((rows) => rows.find((r) => r.provider === "qoder"));

      if (existing) {
        await db.update(accounts).set({
          status: "active",
          tokens: tokens as unknown,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(accounts.id, existing.id));
        pool.invalidate("qoder");
        broadcast({ type: "account_updated", data: { id: existing.id, provider: "qoder", status: "active" } });
        return c.json({ id: existing.id, provider: "qoder", email, status: "active", updated: true }, 200);
      }

      const inserted = await db.insert(accounts).values({
        provider: "qoder",
        email,
        password: encrypt("pat-login"),
        status: "active",
        tokens: tokens as unknown,
        lastLoginAt: new Date(),
      }).returning();
      const created = inserted[0]!;
      pool.invalidate("qoder");
      broadcast({ type: "account_created", data: { id: created.id, provider: "qoder", email } });
      return c.json({ ...created, password: "***", tokens: "[set]" }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Qoder PAT activation failed: ${msg}` }, 400);
    }
  }

  if (!body.email || !body.password) {
    return c.json(
      { error: "email and password are required" },
      400
    );
  }

  const encryptedPassword = encrypt(body.password);

  const newAccount: NewAccount = {
    provider: body.provider,
    email: body.email,
    password: encryptedPassword,
    status: body.tokens ? "active" : (body.status || "pending"),
    tokens: body.tokens || null,
  };

  try {
    const result = await db.insert(accounts).values(newAccount).returning();
    const created = result[0]!;
    pool.invalidate(created.provider as ProviderName);

    broadcast({
      type: "account_created",
      data: { id: created.id, provider: created.provider, email: created.email },
    });

    return c.json(
      { ...created, password: "***", tokens: created.tokens ? "[set]" : null },
      201
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("unique") || error.message.includes("duplicate"))
    ) {
      return c.json({ error: "Account with this email already exists for this provider" }, 409);
    }
    throw error;
  }
});

/**
 * POST /api/accounts/instant-login - Instant login via refresh token (bulk)
 * No browser needed — just exchange refresh token for access token
 * Body: { tokens: ["refreshToken1", ...], provider?: "codex" }
 *
 * - codex: tokens are OpenAI OAuth refresh tokens (start with rt_*, ~200 chars)
 */
accountsRouter.post("/instant-login", async (c) => {
  const body = await c.req.json<{ tokens: string[]; provider?: "codex" }>();

  if (!body.tokens || !Array.isArray(body.tokens) || body.tokens.length === 0) {
    return c.json({ error: "tokens array is required (array of refresh token strings)" }, 400);
  }

  if (body.provider && body.provider !== "codex") {
    return c.json({ error: "Unsupported provider" }, 400);
  }

  return await handleCodexInstantLogin(c, body.tokens);
});

/**
 * POST /api/accounts/bulk - Create multiple accounts
 */
accountsRouter.post("/bulk", async (c) => {
  const body = await c.req.json<{
    accounts: Array<{
      provider: "codex" | "qoder";
      email: string;
      password: string;
    }>;
  }>();

  if (!body.accounts || !Array.isArray(body.accounts)) {
    return c.json({ error: "accounts array is required" }, 400);
  }

  const results: Array<{ email: string; success: boolean; error?: string }> = [];

  for (const acc of body.accounts) {
    try {
      await db.insert(accounts).values({
        provider: acc.provider,
        email: acc.email,
        password: encrypt(acc.password),
        status: "pending",
      });
      results.push({ email: acc.email, success: true });
    } catch (error) {
      results.push({
        email: acc.email,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  pool.invalidate();
  broadcast({ type: "accounts_bulk_created", data: { count: results.filter((r) => r.success).length } });

  return c.json({
    total: body.accounts.length,
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
});

/**
 * PATCH /api/accounts/:id - Update account
 */
accountsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Partial<{
    status: "active" | "exhausted" | "error" | "pending";
    enabled: boolean;
    tokens: Record<string, unknown>;
    password: string;
    quotaLimit: number;
    quotaRemaining: number;
    quotaResetAt: string;
    errorMessage: string | null;
  }>>();

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (body.status) updateData.status = body.status;
  if (typeof body.enabled === "boolean") updateData.enabled = body.enabled;
  if (body.tokens) updateData.tokens = body.tokens;
  if (body.password) updateData.password = encrypt(body.password);
  if (body.quotaLimit !== undefined) updateData.quotaLimit = body.quotaLimit;
  if (body.quotaRemaining !== undefined) updateData.quotaRemaining = body.quotaRemaining;
  if (body.quotaResetAt) updateData.quotaResetAt = new Date(body.quotaResetAt);
  if (body.errorMessage !== undefined) updateData.errorMessage = body.errorMessage;

  const result = await db
    .update(accounts)
    .set(updateData)
    .where(eq(accounts.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Account not found" }, 404);
  }

  const updated = result[0]!;
  pool.invalidate(updated.provider as ProviderName);
  broadcast({
    type: "account_updated",
    data: { id: updated.id, status: updated.status, enabled: updated.enabled, provider: updated.provider },
  });

  return c.json({ ...updated, password: "***", tokens: updated.tokens ? "[set]" : null });
});

/**
 * POST /api/accounts/:id/toggle - Toggle account enabled flag
 */
accountsRouter.post("/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));

  const [current] = await db
    .select({ enabled: accounts.enabled })
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!current) {
    return c.json({ error: "Account not found" }, 404);
  }

  const next = typeof body.enabled === "boolean" ? body.enabled : !current.enabled;
  const updated = await pool.setEnabled(id, next);

  if (!updated) {
    return c.json({ error: "Account not found" }, 404);
  }

  return c.json({
    id: updated.id,
    enabled: updated.enabled,
    status: updated.status,
    provider: updated.provider,
  });
});

/**
 * POST /api/accounts/toggle-all - Bulk toggle enabled for all accounts of a provider
 * Body: { provider: string, enabled: boolean }
 */
accountsRouter.post("/toggle-all", async (c) => {
  const body = await c.req.json<{ provider: string; enabled: boolean }>();

  if (!body.provider) {
    return c.json({ error: "provider is required" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled (boolean) is required" }, 400);
  }

  const count = await pool.setEnabledByProvider(body.provider as ProviderName, body.enabled);
  return c.json({ provider: body.provider, enabled: body.enabled, count });
});

/**
 * POST /api/accounts/bulk-delete - Delete multiple accounts at once.
 *
 * Works for every provider (the row shape is identical). Defined BEFORE the
 * dynamic `/:id` route so Hono matches the literal path first.
 *
 * Body: { ids: number[] }
 * Returns: { success, requested, deleted, providers, notFound }
 */
accountsRouter.post("/bulk-delete", async (c) => {
  const body = await c.req.json<{ ids?: Array<number | string> }>().catch(() => ({} as { ids?: Array<number | string> }));

  // Coerce + dedupe + drop anything non-numeric so a malformed entry can't
  // widen the delete (e.g. NaN turning into "delete everything").
  const ids = Array.from(
    new Set(
      (body.ids ?? [])
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  );

  if (ids.length === 0) {
    return c.json({ error: "ids must be a non-empty array of account ids" }, 400);
  }

  // Resolve providers up front so we can invalidate exactly the affected pools.
  const targets = await db
    .select({ id: accounts.id, provider: accounts.provider })
    .from(accounts)
    .where(inArray(accounts.id, ids));

  if (targets.length === 0) {
    return c.json({ error: "No matching accounts found" }, 404);
  }

  const foundIds = targets.map((t) => t.id);
  const providersAffected = Array.from(new Set(targets.map((t) => t.provider)));

  // Nullify / clean foreign keys before the delete (mirrors DELETE /:id).
  await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, foundIds));

  const result = await db.delete(accounts).where(inArray(accounts.id, foundIds)).returning();
  const deletedIds = result.map((r) => r.id);

  for (const provider of providersAffected) {
    pool.invalidate(provider as ProviderName);
  }
  // Mirror single-delete's broadcast shape per id so existing dashboard
  // listeners (`account_deleted`) keep working without changes, then send
  // one summary frame for clients that prefer the bulk signal.
  for (const id of deletedIds) {
    broadcast({ type: "account_deleted", data: { id } });
  }
  broadcast({ type: "accounts_deleted", data: { ids: deletedIds, providers: providersAffected } });

  const notFound = ids.filter((id) => !foundIds.includes(id));
  return c.json({
    success: true,
    requested: ids.length,
    deleted: deletedIds.length,
    deletedIds,
    providers: providersAffected,
    notFound,
  });
});

/**
 * DELETE /api/accounts/:id - Delete account
 */
accountsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));

  // Nullify foreign key references before deleting
  await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));

  const result = await db
    .delete(accounts)
    .where(eq(accounts.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Account not found" }, 404);
  }

  const deleted = result[0]!;
  pool.invalidate(deleted.provider as ProviderName);
  broadcast({ type: "account_deleted", data: { id } });

  return c.json({ success: true, deleted: id });
});
