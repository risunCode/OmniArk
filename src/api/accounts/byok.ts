import type { Hono } from "hono";
import { db } from "../../db/index";
import { accounts, requestLogs, settings } from "../../db/schema";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "../../utils/crypto";
import { broadcast } from "../../ws/index";
import { pool, type ProviderName } from "../../proxy/pool";

type ByokKeyInput = {
  id?: number;
  label?: string;
  key?: string;
  api_key?: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
};

type ByokTokensShape = {
  base_url?: string;
  api_key?: string;
  format?: "openai" | "anthropic" | "auto";
  models?: string[];
  model_prefix?: string;
  headers?: Record<string, string>;
  key_label?: string;
  weight?: number;
  priority?: number;
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
};

const BYOK_PREFIX_RE = /^[a-z0-9-]+$/;
const BYOK_KEY_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function parseByokTokens(raw: unknown): ByokTokensShape {
  if (!raw) return {};
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as ByokTokensShape;
  } catch {
    return {};
  }
}

function getByokPrefix(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  return tokens.model_prefix || account.email.split("#")[0] || account.email;
}

function getByokKeyLabel(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  if (tokens.key_label) return tokens.key_label;
  const marker = account.email.indexOf("#");
  return marker >= 0 ? account.email.slice(marker + 1) || "default" : "default";
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(models.map((m) => String(m).trim()).filter(Boolean)));
}

function normalizeByokKeys(apiKeys: unknown, legacyApiKey?: string): Array<{ label: string; key: string; weight?: number; priority?: number }> {
  const rawKeys = Array.isArray(apiKeys)
    ? apiKeys as ByokKeyInput[]
    : legacyApiKey
      ? [{ label: "default", key: legacyApiKey }]
      : [];

  const normalized: Array<{ label: string; key: string; weight?: number; priority?: number }> = [];
  const seen = new Set<string>();
  for (const [index, item] of rawKeys.entries()) {
    const label = String(item.label || `key-${index + 1}`).trim().toLowerCase();
    const key = String(item.key || item.api_key || "").trim();
    if (!key) continue;
    if (!BYOK_KEY_LABEL_RE.test(label)) {
      throw new Error("key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore");
    }
    if (seen.has(label)) throw new Error(`duplicate BYOK key label: ${label}`);
    seen.add(label);
    normalized.push({
      label,
      key,
      weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index,
    });
  }
  return normalized;
}

function buildByokEmail(prefix: string, keyLabel: string): string {
  return `${prefix}#${keyLabel}`;
}

function byokLbSettingKey(prefix: string): string {
  return `byok_${prefix}_lb_method`;
}

function normalizeByokLbMethod(value: unknown): "round_robin" | "sequential" | "least_inflight" {
  return value === "sequential" || value === "least_inflight" ? value : "round_robin";
}

async function setByokLbMethod(prefix: string, method: string) {
  const key = byokLbSettingKey(prefix);
  const value = normalizeByokLbMethod(method);
  const existing = await db.select().from(settings).where(eq(settings.key, key));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
  pool.invalidateLoadBalancingCache();
}

async function getByokLbMethods(prefixes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(prefixes.map(byokLbSettingKey));
  const rows = await db.select().from(settings);
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!wanted.has(row.key) || !row.value) continue;
    const prefix = row.key.replace(/^byok_/, "").replace(/_lb_method$/, "");
    result.set(prefix, normalizeByokLbMethod(row.value));
  }
  return result;
}

async function refreshByokRuntime() {
  pool.invalidate("byok" as ProviderName);
  const { refreshByokModels } = await import("../../proxy/providers/registry");
  await refreshByokModels();
}

/**
 * Helper: Auto-fix account if in error state after successful test
 */
async function autoFixAccountIfError(accountId: number, accountStatus: string) {
  if (accountStatus === 'error') {
    await db.update(accounts)
      .set({
        status: 'active',
        errorMessage: null,
        updatedAt: new Date()
      })
      .where(eq(accounts.id, accountId));
    pool.invalidate('byok');
    const { refreshByokModels } = await import("../../proxy/providers/registry");
    await refreshByokModels();
    broadcast({
      type: 'account_status',
      data: { id: accountId, status: 'active' }
    });
    return true;
  }
  return false;
}

export function registerByokRoutes(router: Hono) {
  /**
   * BYOK (Bring Your Own Key) Management Endpoints
   * NOTE: Must be defined BEFORE /:id routes to avoid route collision
   */

  /**
   * POST /api/accounts/byok - Create BYOK provider group with one or more API keys.
   * Backward compatible: accepts either `api_key` or `api_keys[]`.
   */
  router.post("/byok", async (c) => {
    const body = await c.req.json<{
      label: string;
      base_url: string;
      api_key?: string;
      api_keys?: ByokKeyInput[];
      format?: "openai" | "anthropic" | "auto";
      models: string[];
      headers?: Record<string, string>;
      load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
    }>();

    const label = String(body.label || "").trim().toLowerCase();
    const baseUrl = String(body.base_url || "").trim().replace(/\/$/, "");
    const models = normalizeModels(body.models);

    if (!label || !baseUrl || models.length === 0) {
      return c.json({ error: "label, base_url, and models[] are required" }, 400);
    }
    if (!BYOK_PREFIX_RE.test(label)) {
      return c.json({ error: "label must be lowercase alphanumeric with hyphens only" }, 400);
    }

    let keyInputs: Array<{ label: string; key: string; weight?: number; priority?: number }>;
    try {
      keyInputs = normalizeByokKeys(body.api_keys, body.api_key);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (keyInputs.length === 0) {
      return c.json({ error: "At least one API key is required" }, 400);
    }

    const existingByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    if (existingByok.some((acc) => getByokPrefix(acc) === label)) {
      return c.json({ error: "BYOK provider with this label already exists" }, 409);
    }

    try {
      const createdRows = [];
      for (const [index, keyInput] of keyInputs.entries()) {
        const tokens: ByokTokensShape = {
          base_url: baseUrl,
          format: body.format || "auto",
          models,
          model_prefix: label,
          headers: body.headers || {},
          key_label: keyInput.label,
          weight: keyInput.weight,
          priority: keyInput.priority ?? index,
          load_balancing_method: normalizeByokLbMethod(body.load_balancing_method),
        };

        const result = await db.insert(accounts).values({
          provider: "byok",
          email: buildByokEmail(label, keyInput.label),
          password: encrypt(keyInput.key),
          status: "active",
          enabled: true,
          tokens,
          quotaLimit: -1,
          quotaRemaining: -1,
        }).returning();
        if (result[0]) createdRows.push(result[0]);
      }

      await setByokLbMethod(label, normalizeByokLbMethod(body.load_balancing_method));
      await refreshByokRuntime();
      broadcast({
        type: "byok_created",
        data: { id: createdRows[0]?.id, label, keyCount: createdRows.length },
      });

      return c.json({
        success: true,
        id: createdRows[0]?.id,
        label,
        key_count: createdRows.length,
        models: models.map((m) => `${label}-${m}`),
      }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
    }
  });

  /**
   * GET /api/accounts/byok - List BYOK provider groups with masked key metadata.
   */
  router.get("/byok", async (c) => {
    const byokAccounts = await db.select().from(accounts)
      .where(eq(accounts.provider, "byok"));

    const lbMethods = await getByokLbMethods(Array.from(new Set(byokAccounts.map((acc) => getByokPrefix(acc)))));

    const groups = new Map<string, {
      id: number;
      label: string;
      base_url: string;
      format: "openai" | "anthropic" | "auto";
      models: string[];
      model_prefix: string;
      headers?: Record<string, string>;
      status: string;
      enabled: boolean;
      available_models: string[];
      key_count: number;
      active_key_count: number;
      load_balancing_method: string;
      keys: Array<{
        id: number;
        label: string;
        status: string;
        enabled: boolean;
        weight?: number;
        priority?: number;
        lastUsedAt?: Date | null;
        errorMessage?: string | null;
      }>;
    }>();

    for (const acc of byokAccounts) {
      const tokens = parseByokTokens(acc.tokens);
      const prefix = tokens.model_prefix || getByokPrefix(acc);
      const keyLabel = getByokKeyLabel(acc);
      const models = normalizeModels(tokens.models || []);
      const existing = groups.get(prefix);

      if (!existing) {
        groups.set(prefix, {
          id: acc.id,
          label: prefix,
          base_url: tokens.base_url || "",
          format: tokens.format || "auto",
          models,
          model_prefix: prefix,
          headers: tokens.headers || {},
          status: acc.status,
          enabled: Boolean(acc.enabled),
          available_models: models.map((m) => `${prefix}-${m}`),
          key_count: 0,
          active_key_count: 0,
          load_balancing_method: lbMethods.get(prefix) || tokens.load_balancing_method || "round_robin",
          keys: [],
        });
      } else {
        const modelSet = new Set(existing.models);
        for (const model of models) modelSet.add(model);
        existing.models = Array.from(modelSet);
        existing.available_models = existing.models.map((m) => `${prefix}-${m}`);
        existing.enabled = existing.enabled || Boolean(acc.enabled);
        existing.status = existing.status === "active" || acc.status !== "active" ? existing.status : "active";
      }

      const group = groups.get(prefix)!;
      group.key_count += 1;
      if (acc.enabled && acc.status === "active") group.active_key_count += 1;
      group.keys.push({
        id: acc.id,
        label: keyLabel,
        status: acc.status,
        enabled: Boolean(acc.enabled),
        weight: tokens.weight,
        priority: tokens.priority,
        lastUsedAt: acc.lastUsedAt,
        errorMessage: acc.errorMessage,
      });
    }

    const providers = Array.from(groups.values()).map((group) => ({
      ...group,
      keys: group.keys.sort((a, b) => (Number(a.priority ?? 9999) - Number(b.priority ?? 9999)) || a.id - b.id),
    })).sort((a, b) => a.label.localeCompare(b.label));

    return c.json({ providers, total: providers.length });
  });

  /**
   * POST /api/accounts/byok/:id/reveal - Reveal a stored BYOK key secret.
   *
   * The list endpoint intentionally keeps secrets masked. This endpoint is called
   * only on an explicit eye-icon action from the authenticated dashboard so the
   * secret is not sent with normal page loads or websocket refreshes.
   */
  router.post("/byok/:id/reveal", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid BYOK key id" }, 400);

    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK key not found" }, 404);
    }

    try {
      return c.json({
        success: true,
        id: account.id,
        label: getByokKeyLabel(account),
        key: decrypt(account.password),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to decrypt BYOK key" }, 500);
    }
  });

  /**
   * PATCH /api/accounts/byok/:id - Update a BYOK provider group.
   * If `api_keys` is provided it becomes the desired key set: existing keys can be
   * referenced by id/label and omitted keys are deleted from the group.
   */
  router.patch("/byok/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      base_url?: string;
      api_key?: string;
      api_keys?: ByokKeyInput[];
      format?: "openai" | "anthropic" | "auto";
      models?: string[];
      headers?: Record<string, string>;
      load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
    }>();

    const account = await db.select().from(accounts)
      .where(eq(accounts.id, id))
      .get();

    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const prefix = getByokPrefix(account);
    const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
    const currentTokens = parseByokTokens(account.tokens);
    const nextBaseUrl = body.base_url?.trim().replace(/\/$/, "") || currentTokens.base_url || "";
    const nextFormat = body.format || currentTokens.format || "auto";
    const nextModels = body.models ? normalizeModels(body.models) : normalizeModels(currentTokens.models || []);
    const nextHeaders = body.headers ?? currentTokens.headers ?? {};

    if (!nextBaseUrl || nextModels.length === 0) {
      return c.json({ error: "base_url and at least one model are required" }, 400);
    }

    try {
      const keyPayloadProvided = Array.isArray(body.api_keys);
      const desiredKeys = keyPayloadProvided ? (body.api_keys || []) : [];
      const touchedIds = new Set<number>();

      if (keyPayloadProvided) {
        const seenLabels = new Set<string>();
        for (const [index, keyInput] of desiredKeys.entries()) {
          const keyLabel = String(keyInput.label || `key-${index + 1}`).trim().toLowerCase();
          const keySecret = String(keyInput.key || keyInput.api_key || "").trim();
          if (!BYOK_KEY_LABEL_RE.test(keyLabel)) {
            return c.json({ error: "key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore" }, 400);
          }
          if (seenLabels.has(keyLabel)) return c.json({ error: `duplicate BYOK key label: ${keyLabel}` }, 400);
          seenLabels.add(keyLabel);

          const existing = groupAccounts.find((acc) =>
            (keyInput.id && acc.id === keyInput.id) || getByokKeyLabel(acc) === keyLabel
          );
          const tokens: ByokTokensShape = {
            ...parseByokTokens(existing?.tokens),
            base_url: nextBaseUrl,
            format: nextFormat,
            models: nextModels,
            model_prefix: prefix,
            headers: nextHeaders,
            key_label: keyLabel,
            weight: Number.isFinite(Number(keyInput.weight)) ? Number(keyInput.weight) : undefined,
            priority: Number.isFinite(Number(keyInput.priority)) ? Number(keyInput.priority) : index,
            load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || currentTokens.load_balancing_method),
          };

          if (existing) {
            const updateData: Record<string, unknown> = {
              email: buildByokEmail(prefix, keyLabel),
              tokens,
              enabled: typeof keyInput.enabled === "boolean" ? keyInput.enabled : existing.enabled,
              updatedAt: new Date(),
            };
            if (keySecret) updateData.password = encrypt(keySecret);
            await db.update(accounts).set(updateData).where(eq(accounts.id, existing.id));
            touchedIds.add(existing.id);
          } else {
            if (!keySecret) return c.json({ error: `new key "${keyLabel}" requires a secret` }, 400);
            const inserted = await db.insert(accounts).values({
              provider: "byok",
              email: buildByokEmail(prefix, keyLabel),
              password: encrypt(keySecret),
              status: "active",
              enabled: keyInput.enabled ?? true,
              tokens,
              quotaLimit: -1,
              quotaRemaining: -1,
            }).returning();
            if (inserted[0]) touchedIds.add(inserted[0].id);
          }
        }

        const toDelete = groupAccounts.filter((acc) => !touchedIds.has(acc.id));
        for (const acc of toDelete) {
          await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, acc.id));
          await db.delete(accounts).where(eq(accounts.id, acc.id));
        }
      } else {
        for (const acc of groupAccounts) {
          const tokens = parseByokTokens(acc.tokens);
          const updateData: Record<string, unknown> = {
            tokens: {
              ...tokens,
              base_url: nextBaseUrl,
              format: nextFormat,
              models: nextModels,
              model_prefix: prefix,
              headers: nextHeaders,
              load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || tokens.load_balancing_method),
            },
            updatedAt: new Date(),
          };
          if (body.api_key && acc.id === id) updateData.password = encrypt(body.api_key);
          await db.update(accounts).set(updateData).where(eq(accounts.id, acc.id));
        }
      }

      await setByokLbMethod(prefix, normalizeByokLbMethod(body.load_balancing_method || currentTokens.load_balancing_method));
      await refreshByokRuntime();
      broadcast({ type: "byok_updated", data: { id, label: prefix } });

      return c.json({
        success: true,
        id,
        label: prefix,
        models: nextModels.map((m) => `${prefix}-${m}`),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
    }
  });

  /**
   * DELETE /api/accounts/byok/:id - Delete a BYOK provider group and all keys in it.
   */
  router.delete("/byok/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();

    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const prefix = getByokPrefix(account);
    const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
    const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
    const deletedIds: number[] = [];

    for (const acc of groupAccounts) {
      await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, acc.id));
      const result = await db.delete(accounts).where(eq(accounts.id, acc.id)).returning();
      if (result[0]) deletedIds.push(result[0].id);
    }

    await refreshByokRuntime();
    broadcast({ type: "byok_deleted", data: { id, label: prefix, deletedIds } });

    return c.json({ success: true, deleted: id, deletedIds, label: prefix });
  });

  /**
   * POST /api/accounts/byok/:id/test - Test BYOK connection
   * Accepts optional { model?: string } body to test a specific model.
   * Returns latency_ms and auto_fixed status.
   */
  router.post("/byok/:id/test", async (c) => {
    const id = Number(c.req.param("id"));
    const reqBody = await c.req.json().catch(() => ({})) as { model?: string };

    const account = await db.select().from(accounts)
      .where(eq(accounts.id, id))
      .get();

    if (!account || account.provider !== "byok") {
      return c.json({ error: "BYOK provider not found" }, 404);
    }

    const tokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : account.tokens;

    if (!tokens?.base_url || !tokens?.models || tokens.models.length === 0) {
      return c.json({ success: false, error: "Invalid BYOK configuration" });
    }

    const apiKey = decrypt(account.password);
    const format = tokens.format || "auto";
    const testModel = reqBody.model || tokens.models[0];

    // Validate model if provided
    if (reqBody.model && !tokens.models.includes(reqBody.model)) {
      return c.json({
        success: false,
        error: `Model "${reqBody.model}" not found in provider configuration`
      }, 400);
    }

    // Determine endpoint based on format
    const isAnthropic = format === "anthropic" ||
      (format === "auto" && (tokens.base_url.includes("anthropic.com") || tokens.base_url.includes("/v1/messages")));

    const url = isAnthropic
      ? `${tokens.base_url}/messages`
      : `${tokens.base_url}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(tokens.headers || {}),
    };

    const body = isAnthropic
      ? {
          model: testModel,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }
      : {
          model: testModel,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        };

    if (isAnthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      const startTime = Date.now();
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const latencyMs = Date.now() - startTime;

      if (response.status === 401 || response.status === 403) {
        return c.json({ success: false, error: "Authentication failed", latency_ms: latencyMs });
      }

      if (response.status === 429) {
        const autoFixed = await autoFixAccountIfError(id, account.status);
        return c.json({
          success: true,
          warning: "Rate limited but authentication works",
          latency_ms: latencyMs,
          auto_fixed: autoFixed
        });
      }

      if (!response.ok) {
        const text = await response.text();
        return c.json({ success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, latency_ms: latencyMs });
      }

      const autoFixed = await autoFixAccountIfError(id, account.status);
      return c.json({
        success: true,
        message: "Connection test passed",
        model: testModel,
        format: isAnthropic ? "anthropic" : "openai",
        latency_ms: latencyMs,
        auto_fixed: autoFixed
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : "Network error",
      });
    }
  });
}
