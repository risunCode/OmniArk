import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/index";
import { apiKeys, apiKeyUsage, settings, type ApiKey } from "../db/schema";

const API_KEY_SETTING = "api_key";
const API_KEY_CACHE_TTL_MS = 5_000;

let activeApiKeyCache: { key: string; expiresAt: number } | null = null;

export interface ApiKeyPrincipal {
  id: number | null;
  name: string;
  managed: boolean;
  policy: ApiKey | null;
}

interface KeyPolicyInput {
  name?: unknown;
  key?: unknown;
  modelAllowlist?: unknown;
  dailyTokenLimit?: unknown;
  monthlyTokenLimit?: unknown;
  totalHitLimit?: unknown;
  expiresAt?: unknown;
}

interface KeyPolicyValues {
  name: string;
  key?: string;
  modelAllowlist: string[];
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  totalHitLimit: number | null;
  expiresAt: Date | null;
}

export const keysRouter = new Hono();

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk-pool-${token}`;
}

async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function keyPrefix(key: string): string {
  return key.length <= 12 ? key : `${key.slice(0, 12)}…`;
}

function parseLimit(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive whole number`);
  return parsed;
}

function parseAllowlist(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((model) => typeof model !== "string" || !model.trim())) {
    throw new Error("modelAllowlist must be an array of model IDs");
  }
  return [...new Set(value.map((model) => model.trim()))];
}

function parseExpiration(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("expiresAt must be an ISO date-time");
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) throw new Error("expiresAt must be in the future");
  return date;
}

function parseKeyPolicy(body: KeyPolicyInput, requireName: boolean, fallback?: KeyPolicyValues): KeyPolicyValues {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (requireName && !name) throw new Error("name is required");
  if (name.length > 80) throw new Error("name must be 80 characters or fewer");
  const key = body.key === undefined ? undefined : typeof body.key === "string" ? body.key.trim() : "";
  if (key !== undefined && key.length < 16) throw new Error("API key must be at least 16 characters");
  return {
    name,
    key,
    modelAllowlist: body.modelAllowlist === undefined ? fallback?.modelAllowlist || [] : parseAllowlist(body.modelAllowlist),
    dailyTokenLimit: body.dailyTokenLimit === undefined ? fallback?.dailyTokenLimit || null : parseLimit(body.dailyTokenLimit, "Daily token limit"),
    monthlyTokenLimit: body.monthlyTokenLimit === undefined ? fallback?.monthlyTokenLimit || null : parseLimit(body.monthlyTokenLimit, "Monthly token limit"),
    totalHitLimit: body.totalHitLimit === undefined ? fallback?.totalHitLimit || null : parseLimit(body.totalHitLimit, "Total hit limit"),
    expiresAt: body.expiresAt === undefined ? fallback?.expiresAt || null : parseExpiration(body.expiresAt),
  };
}

function getUsagePeriods(now = new Date()): { day: string; month: string } {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return { day: `day:${year}-${month}-${day}`, month: `month:${year}-${month}` };
}

export function getApiKeyModelAllowlist(policy: ApiKey): string[] {
  return Array.isArray(policy.modelAllowlist)
    ? policy.modelAllowlist.filter((model): model is string => typeof model === "string")
    : [];
}

async function getUsage(apiKeyId: number): Promise<{ dailyTokens: number; monthlyTokens: number }> {
  const periods = getUsagePeriods();
  const rows = await db.select().from(apiKeyUsage).where(and(
    eq(apiKeyUsage.apiKeyId, apiKeyId),
    sql`${apiKeyUsage.period} IN (${periods.day}, ${periods.month})`
  ));
  return {
    dailyTokens: rows.find((row) => row.period === periods.day)?.tokens || 0,
    monthlyTokens: rows.find((row) => row.period === periods.month)?.tokens || 0,
  };
}

function serializeKey(key: ApiKey, usage: { dailyTokens: number; monthlyTokens: number }) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    modelAllowlist: getApiKeyModelAllowlist(key),
    dailyTokenLimit: key.dailyTokenLimit,
    monthlyTokenLimit: key.monthlyTokenLimit,
    totalHitLimit: key.totalHitLimit,
    totalHits: key.totalHits,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
    ...usage,
  };
}

export async function getActiveApiKey(): Promise<string> {
  const now = Date.now();
  if (activeApiKeyCache && activeApiKeyCache.expiresAt > now) return activeApiKeyCache.key;
  const [row] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  const key = row?.value || config.apiKey;
  activeApiKeyCache = { key, expiresAt: now + API_KEY_CACHE_TTL_MS };
  return key;
}

export async function authenticateApiKey(token: string): Promise<ApiKeyPrincipal | null> {
  if (!token) return null;
  if (token === config.apiKey || token === await getActiveApiKey()) {
    return { id: null, name: "Primary API key", managed: false, policy: null };
  }
  const keyHash = await hashApiKey(token);
  const [policy] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
  if (!policy) return null;
  return { id: policy.id, name: policy.name, managed: true, policy };
}

export async function isValidApiKey(token: string): Promise<boolean> {
  return (await authenticateApiKey(token)) !== null;
}

export async function checkApiKeyPolicy(principal: ApiKeyPrincipal, model?: string): Promise<{ message: string; status: 403 | 429 } | null> {
  if (!principal.policy) return null;
  const policy = principal.policy;
  if (policy.expiresAt && policy.expiresAt.getTime() <= Date.now()) return { message: "API key has expired", status: 403 };
  if (policy.totalHitLimit && policy.totalHits >= policy.totalHitLimit) return { message: "API key total hit limit has been reached", status: 429 };
  const modelAllowlist = getApiKeyModelAllowlist(policy);
  if (model && modelAllowlist.length > 0 && !modelAllowlist.includes(model)) {
    return { message: `API key is not allowed to use model '${model}'`, status: 403 };
  }
  const usage = await getUsage(policy.id);
  if (policy.dailyTokenLimit && usage.dailyTokens >= policy.dailyTokenLimit) return { message: "API key daily token limit has been reached", status: 429 };
  if (policy.monthlyTokenLimit && usage.monthlyTokens >= policy.monthlyTokenLimit) return { message: "API key monthly token limit has been reached", status: 429 };
  return null;
}

export async function recordApiKeySuccess(principal: ApiKeyPrincipal, totalTokens: number): Promise<void> {
  if (!principal.id) return;
  const periods = getUsagePeriods();
  const tokens = Math.max(0, Math.floor(totalTokens));
  await db.update(apiKeys).set({ totalHits: sql`${apiKeys.totalHits} + 1`, lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(apiKeys.id, principal.id));
  for (const period of [periods.day, periods.month]) {
    await db.run(sql`
      INSERT INTO api_key_usage (api_key_id, period, tokens) VALUES (${principal.id}, ${period}, ${tokens})
      ON CONFLICT (api_key_id, period) DO UPDATE SET tokens = api_key_usage.tokens + excluded.tokens
    `);
  }
}

async function saveApiKey(key: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  if (existing.length > 0) await db.update(settings).set({ value: key, updatedAt: new Date() }).where(eq(settings.key, API_KEY_SETTING));
  else await db.insert(settings).values({ key: API_KEY_SETTING, value: key });
  activeApiKeyCache = { key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS };
}

keysRouter.get("/", async (c) => {
  const key = await getActiveApiKey();
  return c.json({ key, source: key === config.apiKey ? "env" : "database" });
});

keysRouter.post("/regenerate", async (c) => {
  const key = generateApiKey();
  await saveApiKey(key);
  return c.json({ key, source: "database" });
});

keysRouter.post("/set", async (c) => {
  const body = await c.req.json<{ key: string }>();
  if (!body.key || body.key.length < 16) return c.json({ error: "API key must be at least 16 characters" }, 400);
  await saveApiKey(body.key);
  return c.json({ key: body.key, source: "database" });
});

keysRouter.post("/test", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const principal = await authenticateApiKey(body.key || "");
  const violation = principal ? await checkApiKeyPolicy(principal) : null;
  return c.json({ valid: principal !== null && violation === null });
});

keysRouter.get("/custom", async (c) => {
  const keys = await db.select().from(apiKeys).orderBy(apiKeys.createdAt);
  return c.json({ data: await Promise.all(keys.map(async (key) => serializeKey(key, await getUsage(key.id)))) });
});

keysRouter.post("/custom", async (c) => {
  try {
    const values = parseKeyPolicy(await c.req.json<KeyPolicyInput>(), true);
    const key = values.key || generateApiKey();
    const keyHash = await hashApiKey(key);
    const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    if (existing || key === config.apiKey || key === await getActiveApiKey()) return c.json({ error: "API key is already in use" }, 409);
    const [created] = await db.insert(apiKeys).values({
      name: values.name,
      keyHash,
      keyPrefix: keyPrefix(key),
      modelAllowlist: values.modelAllowlist,
      dailyTokenLimit: values.dailyTokenLimit,
      monthlyTokenLimit: values.monthlyTokenLimit,
      totalHitLimit: values.totalHitLimit,
      expiresAt: values.expiresAt,
    }).returning();
    return c.json({ data: serializeKey(created!, { dailyTokens: 0, monthlyTokens: 0 }), key }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid API key policy" }, 400);
  }
});

keysRouter.patch("/custom/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "Invalid API key ID" }, 400);
  try {
    const body = await c.req.json<KeyPolicyInput>();
    const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    if (!existing) return c.json({ error: "API key not found" }, 404);
    const values = parseKeyPolicy(body, true, {
      name: existing.name,
      modelAllowlist: getApiKeyModelAllowlist(existing),
      dailyTokenLimit: existing.dailyTokenLimit,
      monthlyTokenLimit: existing.monthlyTokenLimit,
      totalHitLimit: existing.totalHitLimit,
      expiresAt: existing.expiresAt,
    });
    await db.update(apiKeys).set({
      name: values.name,
      modelAllowlist: values.modelAllowlist,
      dailyTokenLimit: values.dailyTokenLimit,
      monthlyTokenLimit: values.monthlyTokenLimit,
      totalHitLimit: values.totalHitLimit,
      expiresAt: values.expiresAt,
      updatedAt: new Date(),
    }).where(eq(apiKeys.id, id));
    const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    return c.json({ data: serializeKey(updated!, await getUsage(id)) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid API key policy" }, 400);
  }
});

keysRouter.post("/custom/:id/rotate", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "Invalid API key ID" }, 400);
  const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!existing) return c.json({ error: "API key not found" }, 404);
  const key = generateApiKey();
  await db.update(apiKeys).set({ keyHash: await hashApiKey(key), keyPrefix: keyPrefix(key), updatedAt: new Date() }).where(eq(apiKeys.id, id));
  const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  return c.json({ data: serializeKey(updated!, await getUsage(id)), key });
});

keysRouter.delete("/custom/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "Invalid API key ID" }, 400);
  const result = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id });
  if (result.length === 0) return c.json({ error: "API key not found" }, 404);
  return c.body(null, 204);
});
