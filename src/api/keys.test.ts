import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { apiKeys } from "../db/schema";
import { authenticateApiKey, checkApiKeyPolicy, getApiKeyModelAllowlist, recordApiKeySuccess } from "./keys";

const testKey = "sk-pool-policy-test-0123456789abcdef";
let createdId: number | null = null;

describe("managed API key policies", () => {
  beforeAll(async () => {
    const keyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(testKey));
    const hash = Array.from(new Uint8Array(keyHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hash));
    const [created] = await db.insert(apiKeys).values({
      name: "Policy test key",
      keyHash: hash,
      keyPrefix: "sk-pool-test",
      modelAllowlist: ["allowed-model"],
      dailyTokenLimit: 100,
      monthlyTokenLimit: 200,
      totalHitLimit: 2,
    }).returning({ id: apiKeys.id });
    createdId = created!.id;
  });

  afterAll(async () => {
    if (createdId) await db.delete(apiKeys).where(eq(apiKeys.id, createdId));
  });

  it("authenticates a managed key and enforces its model ACL", async () => {
    const principal = await authenticateApiKey(testKey);
    expect(principal?.managed).toBe(true);
    expect(getApiKeyModelAllowlist(principal!.policy!)).toEqual(["allowed-model"]);
    expect(await checkApiKeyPolicy(principal!, "denied-model")).toEqual({
      message: "API key is not allowed to use model 'denied-model'",
      status: 403,
    });
  });

  it("tracks hits and token quota usage for managed keys", async () => {
    const principal = await authenticateApiKey(testKey);
    expect(principal).not.toBeNull();
    await recordApiKeySuccess(principal!, 100);
    expect(await checkApiKeyPolicy(principal!, "allowed-model")).toEqual({
      message: "API key daily token limit has been reached",
      status: 429,
    });
  });
});
