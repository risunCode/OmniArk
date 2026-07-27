import { Hono } from "hono";
import { db } from "../db/index";
import { proxyPool } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import {
  checkProxyHealth,
  invalidateProxyCache,
} from "../services/proxy-pool";

export const proxyPoolRouter = new Hono();

proxyPoolRouter.get("/pool", async (c) => {
  const proxies = await db
    .select()
    .from(proxyPool)
    .orderBy(desc(proxyPool.createdAt));

  return c.json({
    count: proxies.length,
    activeCount: proxies.filter((p) => p.status === "active").length,
    proxies,
  });
});

proxyPoolRouter.post("/pool", async (c) => {
  const body = await c.req.json<{ proxies: string[]; type?: "http" | "vercel" | "cloudflare" }>();
  if (!Array.isArray(body.proxies) || body.proxies.length === 0) {
    return c.json({ error: "proxies must be a non-empty array of URLs" }, 400);
  }

  const type = body.type === "vercel" || body.type === "cloudflare" ? body.type : "http";
  const invalid: string[] = [];
  let added = 0;
  for (const url of body.proxies) {
    const trimmed = url.trim();
    if (!trimmed) continue;

    let label: string;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported URL protocol");
      label = parsed.hostname || trimmed;
    } catch {
      invalid.push(trimmed);
      continue;
    }

    await db.insert(proxyPool).values({ url: trimmed, type, label });
    added++;
  }

  invalidateProxyCache();
  return c.json({ added, invalid });
});

proxyPoolRouter.put("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status?: string; label?: string }>();

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.status) updates.status = body.status;
  if (body.label !== undefined) updates.label = body.label;

  await db.update(proxyPool).set(updates).where(eq(proxyPool.id, id));
  invalidateProxyCache();

  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(proxyPool).where(eq(proxyPool.id, id));
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.delete("/pool", async (c) => {
  await db.delete(proxyPool);
  invalidateProxyCache();
  return c.json({ success: true });
});

proxyPoolRouter.post("/pool/:id/check", async (c) => {
  const id = Number(c.req.param("id"));
  const [proxy] = await db.select().from(proxyPool).where(eq(proxyPool.id, id));
  if (!proxy) return c.json({ error: "Proxy not found" }, 404);

  const type = proxy.type === "vercel" || proxy.type === "cloudflare" ? proxy.type : "http";
  const result = await checkProxyHealth(proxy.url, type);

  await db
    .update(proxyPool)
    .set({
      status: result.ok ? "active" : "error",
      errorMessage: result.error || null,
      latencyMs: result.latencyMs,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proxyPool.id, id));

  invalidateProxyCache();
  return c.json({ id, ...result });
});

proxyPoolRouter.post("/pool/check-all", async (c) => {
  const proxies = await db
    .select()
    .from(proxyPool)
    .where(eq(proxyPool.status, "active"));

  const results = await Promise.allSettled(
    proxies.map(async (proxy) => {
      const type = proxy.type === "vercel" || proxy.type === "cloudflare" ? proxy.type : "http";
      const result = await checkProxyHealth(proxy.url, type);
      await db
        .update(proxyPool)
        .set({
          status: result.ok ? "active" : "error",
          errorMessage: result.error || null,
          latencyMs: result.latencyMs,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proxyPool.id, proxy.id));
      return { id: proxy.id, url: proxy.url, ...result };
    })
  );

  invalidateProxyCache();
  return c.json({
    checked: results.length,
    results: results.map((r) => (r.status === "fulfilled" ? r.value : { error: "check failed" })),
  });
});
