import { Hono } from "hono";
import { routeRequest, getAllModels, providers } from "./router";
import { db } from "../db/index";
import { requestLogs, usageSummary, accounts, type NewRequestLog } from "../db/schema";
import { pool } from "./pool";
import { broadcast } from "../ws/index";
import type { ChatCompletionRequest, CreditSource } from "./providers/base";
import {
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  type AnthropicMessagesRequest,
} from "./transforms/anthropic";
import { isBadUpstreamRequest, isInvalidModelError } from "./errors";
import { prepareLogBody } from "./logging";
import { resolveModelAlias } from "./model-mapping";
import { eq, sql } from "drizzle-orm";
import { providerList, refreshByokModels } from "./providers/registry";
import { checkApiKeyPolicy, getApiKeyModelAllowlist, recordApiKeySuccess, type ApiKeyPrincipal } from "../api/keys";

export const proxyRouter = new Hono<{ Variables: { apiKeyPrincipal: ApiKeyPrincipal } }>();

const MAX_REQUEST_LOGS = 50;

/** Upsert a request's stats into the usage_summary table (hourly bucket) */
async function upsertUsageSummary(entry: {
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  estimatedCost: number;
  creditsUsed: number;
  durationMs: number;
}) {
  try {
    const bucket = new Date();
    bucket.setMinutes(0, 0, 0); // truncate to hour

    await db.run(sql`
      INSERT INTO usage_summary (bucket, provider, model, total_requests, success_requests, error_requests, prompt_tokens, completion_tokens, total_tokens, cached_tokens, estimated_cost, credits_used, total_duration_ms)
      VALUES (${bucket.toISOString()}, ${entry.provider || "unknown"}, ${entry.model || "unknown"}, 1,
        ${entry.status === "success" ? 1 : 0}, ${entry.status === "error" ? 1 : 0},
        ${entry.promptTokens || 0}, ${entry.completionTokens || 0}, ${entry.totalTokens || 0}, ${entry.cachedTokens || 0}, ${entry.estimatedCost || 0},
        ${entry.creditsUsed || 0}, ${entry.durationMs || 0})
      ON CONFLICT (bucket, provider, model) DO UPDATE SET
        total_requests = usage_summary.total_requests + excluded.total_requests,
        success_requests = usage_summary.success_requests + excluded.success_requests,
        error_requests = usage_summary.error_requests + excluded.error_requests,
        prompt_tokens = usage_summary.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = usage_summary.completion_tokens + excluded.completion_tokens,
        total_tokens = usage_summary.total_tokens + excluded.total_tokens,
        cached_tokens = usage_summary.cached_tokens + excluded.cached_tokens,
        estimated_cost = usage_summary.estimated_cost + excluded.estimated_cost,
        credits_used = usage_summary.credits_used + excluded.credits_used,
        total_duration_ms = usage_summary.total_duration_ms + excluded.total_duration_ms
    `);
  } catch (err) {
    console.error("[Proxy] Failed to upsert usage_summary:", err);
  }
}

/** Prune request_logs to keep only the most recent MAX_REQUEST_LOGS rows */
async function pruneRequestLogs() {
  try {
    await db.run(sql`
      DELETE FROM request_logs WHERE id NOT IN (
        SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ${MAX_REQUEST_LOGS}
      )
    `);
  } catch (err) {
    console.error("[Proxy] Failed to prune request_logs:", err);
  }
}

// Prune every 10 requests to avoid running DELETE on every single insert
let requestCounter = 0;

export async function recordRequest(entry: NewRequestLog) {
  try {
    const [created] = await db.insert(requestLogs).values(entry).returning();
    void upsertUsageSummary({
      provider: entry.provider || "unknown",
      model: entry.model || "unknown",
      status: entry.status,
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      totalTokens: entry.totalTokens || 0,
      cachedTokens: entry.cachedTokens || 0,
      estimatedCost: entry.estimatedCost || 0,
      creditsUsed: entry.creditsUsed || 0,
      durationMs: entry.durationMs || 0,
    });
    if (++requestCounter % 10 === 0) void pruneRequestLogs();
    broadcast({
      type: "request_log",
      data: {
        ...entry,
        id: created?.id,
        email: entry.accountEmail,
        createdAt: created?.createdAt?.toISOString?.() || new Date().toISOString(),
      },
    });
    return created;
  } catch (err) {
    console.error("[Proxy] Failed to record request:", err);
    return undefined;
  }
}

function normalizeModelId(model: string): string {
  // Common typo seen from clients: "sonet" -> canonical Anthropic "sonnet".
  return model.replace(/claude-sonet/gi, "claude-sonnet");
}


function computeCredits(
  provider: keyof typeof providers,
  model: string,
  totalTokens: number,
  resultCredits?: number,
  resultCreditSource?: CreditSource
) {
  if (resultCredits !== undefined && resultCredits > 0) {
    return {
      creditsUsed: Math.max(0.01, resultCredits),
      creditSource: resultCreditSource || "upstream" as CreditSource,
    };
  }

  if (totalTokens > 0) {
    return {
      creditsUsed: Math.max(0.01, totalTokens * providers[provider].getProviderCreditRate(model)),
      creditSource: "estimated" as CreditSource,
    };
  }

  return {
    creditsUsed: 0,
    creditSource: resultCreditSource || "estimated" as CreditSource,
  };
}

function estimateCost(totalTokens: number, creditRate: number): number {
  return Math.max(0, totalTokens) * Math.max(0, creditRate);
}

function extractUsageFromSsePayload(payload: string) {
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload);
    const usage = parsed.usage;
    const choice = parsed.choices?.[0];
    const content = String(
      choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      parsed?.delta?.content ??
      parsed?.content ??
      parsed?.text ??
      ""
    );

    return {
      content,
      promptTokens: Number(usage?.prompt_tokens || usage?.input_tokens || 0),
      completionTokens: Number(usage?.completion_tokens || usage?.output_tokens || 0),
      totalTokens: Number(usage?.total_tokens || 0),
      cachedTokens: Number(usage?.cached_tokens || usage?.cache_read_input_tokens || usage?.cacheReadInputTokens || usage?.prompt_cache_hit_tokens || usage?.cached_input_tokens || usage?.prompt_tokens_details?.cached_tokens || usage?.input_tokens_details?.cached_tokens || 0),
      creditsUsed: Number(usage?.credits_used || usage?.creditsUsed || usage?.credit || parsed.credits_used || parsed.creditsUsed || 0),
    };
  } catch {
    return null;
  }
}

/** Accumulate streamed text content across SSE chunks for token estimation */
function extractStreamContent(payload: string): string {
  if (!payload || payload === "[DONE]") return "";
  try {
    const parsed = JSON.parse(payload);
    const choice = parsed.choices?.[0];
    return String(
      choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      parsed?.delta?.content ??
      parsed?.content ??
      parsed?.text ??
      ""
    );
  } catch {
    return "";
  }
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessagesTokens(messages: ChatCompletionRequest["messages"]): number {
  return (messages || []).reduce((total, msg) => {
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as any[])
        .map((block) => {
          if (block?.type === "text" && typeof block.text === "string") return block.text;
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") return block.content;
            if (Array.isArray(block.content)) {
              return block.content.map((b: any) => b?.text || "").join("");
            }
          }
          return JSON.stringify(block || "");
        })
        .join("");
    } else {
      content = JSON.stringify(msg.content || "");
    }
    return total + estimateTokensFromText(content) + 4;
  }, 0);
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError ||
    (error instanceof Error && /json|parse|unexpected end|unexpected token/i.test(error.message));
}

function openAIErrorResponse(message: string, status: 400 | 503) {
  return {
    error: {
      message,
      type: status === 400 ? "invalid_request_error" : "server_error",
      code: status === 400 ? "invalid_json" : "proxy_error",
    },
  };
}

async function logProxyError(entry: NewRequestLog, label: string) {
  try {
    await db.insert(requestLogs).values(entry);
    // Also track errors in usage_summary
    void upsertUsageSummary({
      provider: entry.provider || "unknown", model: entry.model || "unknown", status: "error",
      promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, estimatedCost: 0, creditsUsed: 0, durationMs: entry.durationMs || 0,
    });
    if (++requestCounter % 10 === 0) void pruneRequestLogs();
  } catch (logError) {
    console.error(`[Proxy] Failed to log ${label}:`, logError);
  }
}

function wrapStreamWithUsageFinalizer(
  stream: ReadableStream<Uint8Array>,
  context: {
    logId?: number;
    accountId: number;
    accountEmail: string;
    provider: keyof typeof providers;
    model: string;
    quotaBefore: number;
    startedAt: number;
    fallbackPromptTokens: number;
    fallbackCompletionTokens: number;
    fallbackTotalTokens: number;
    fallbackCreditsUsed: number;
    fallbackCreditSource: CreditSource;
    useFreeCounter: boolean;
    apiKeyPrincipal: ApiKeyPrincipal;
  }
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let reader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  let buffer = "";
  let streamedContent = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let upstreamCredits = 0;
  let finalized = false;
  let streamError = false;

  const observe = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

      // Detect upstream errors in SSE stream (Qoder 403 in body, OpenAI error format)
      const trimmedPayload = payload.trim();
      if (trimmedPayload && trimmedPayload !== "[DONE]") {
        try {
          const parsed = JSON.parse(trimmedPayload);
          // Qoder upstream error: { type: "upstream_error", error: "message" }
          if (parsed.type === "upstream_error") {
            streamError = true;
          }
          // Qoder format: {"code":"112","statusCodeValue":403,"message":"..."}
          if (parsed.statusCodeValue && parsed.statusCodeValue >= 400) {
            streamError = true;
          }
          // OpenAI format: {"error": {"message": "...", "type": "..."}}
          if (parsed.error && (typeof parsed.error === "object" || typeof parsed.error === "string")) {
            streamError = true;
          }
        } catch {
          // not JSON, skip
        }
      }

      // Always extract content for estimation, even if no usage field
      const content = extractStreamContent(trimmedPayload);
      if (content) streamedContent += content;

      const usage = extractUsageFromSsePayload(trimmedPayload);
      if (!usage) continue;
      promptTokens = usage.promptTokens || promptTokens;
      completionTokens = usage.completionTokens || completionTokens;
      totalTokens = usage.totalTokens || totalTokens;
      cachedTokens = usage.cachedTokens || cachedTokens;
      upstreamCredits = usage.creditsUsed || upstreamCredits;
    }
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;

    const finalPromptTokens = promptTokens || context.fallbackPromptTokens;
    const finalCompletionTokens = completionTokens || estimateTokensFromText(streamedContent) || context.fallbackCompletionTokens;
    const finalTotalTokens = totalTokens || finalPromptTokens + finalCompletionTokens || context.fallbackTotalTokens;
    const finalCachedTokens = cachedTokens;
    const { creditsUsed, creditSource } = computeCredits(
      context.provider,
      context.model,
      finalTotalTokens,
      upstreamCredits || context.fallbackCreditsUsed,
      upstreamCredits > 0 ? "upstream" : context.fallbackCreditSource
    );
    const durationMs = Math.max(0, Date.now() - context.startedAt);
    const estimatedCost = estimateCost(finalTotalTokens, providers[context.provider].getProviderCreditRate(context.model));

    void (async () => {
      try {
        const isQoder = context.provider === "qoder";

        // If stream had upstream error (403 rate limit, empty stream, etc), don't decrement quota
        // and mark account exhausted for Qoder — but verify with a probe first.
        // Stream errors on Qoder are a noisy signal: rate-limit-per-second,
        // signature replay protection, transient auth all surface as 403.
        // The qd-Lite probe is the authoritative arbiter.
        if (streamError) {
          if (isQoder) {
            // Trust upstream: if Qoder returned a stream error (typically a
            // 403 due to genuine quota exhaustion or rate-limit), mark the
            // account exhausted immediately. The quota-sync runner will flip it
            // back to active once Qoder reports available quota again. No probe —
            // we'd rather pay the occasional false-exhaust (lifted on the next
            // sync) than serve a known-bad account.
            await pool.markExhausted(context.accountId);
          }
          // Still update request log with error status
          if (context.logId) {
            await db
              .update(requestLogs)
              .set({
                status: "error",
                errorMessage: "Upstream rate limit or quota exceeded",
                durationMs,
              })
              .where(eq(requestLogs.id, context.logId));
          }
          return;
        }

        // Decrement at stream finalization. Qoder free-bucket (qmodel_latest)
        // charges 1 request per call; other Qoder buckets stay unchanged
        // (no local counter — server is sole truth). Non-Qoder providers
        // keep existing token-based decrement.
        let quotaAfter = context.quotaBefore;
        if (isQoder && context.useFreeCounter && context.quotaBefore > 0) {
          quotaAfter = await pool.decrementFreeQuota(context.accountId, 1);
        } else if (!isQoder && context.quotaBefore > 0) {
          quotaAfter = await pool.decrementQuota(context.accountId, creditsUsed);
        }

        if (context.logId) {
          await db
            .update(requestLogs)
            .set({
              promptTokens: finalPromptTokens,
              completionTokens: finalCompletionTokens,
              totalTokens: finalTotalTokens,
              cachedTokens: finalCachedTokens,
              estimatedCost,
              creditsUsed,
              durationMs,
              accountQuotaAfter: quotaAfter,
            })
            .where(eq(requestLogs.id, context.logId));
        }

        await recordApiKeySuccess(context.apiKeyPrincipal, finalTotalTokens);

        broadcast({
          type: "request_log",
          data: {
            id: context.logId,
            accountId: context.accountId,
            accountEmail: context.accountEmail,
            email: context.accountEmail,
            provider: context.provider,
            model: context.model,
            promptTokens: finalPromptTokens,
            completionTokens: finalCompletionTokens,
            totalTokens: finalTotalTokens,
            cachedTokens: finalCachedTokens,
            estimatedCost,
            creditsUsed,
            status: "success",
            durationMs,
            accountQuotaBefore: context.quotaBefore,
            accountQuotaAfter: quotaAfter,
            createdAt: new Date(context.startedAt).toISOString(),
            requestBody: prepareLogBody({
              model: context.model,
              stream: true,
              _omniark: {
                creditSource,
                creditUnit: providers[context.provider].getProviderCreditUnit(context.model),
                creditRate: providers[context.provider].getProviderCreditRate(context.model),
              },
            }),
          },
        });

        // Upsert to usage_summary + periodic prune
        void upsertUsageSummary({
          provider: context.provider, model: context.model, status: "success",
          promptTokens: finalPromptTokens, completionTokens: finalCompletionTokens,
          totalTokens: finalTotalTokens, cachedTokens: finalCachedTokens, estimatedCost, creditsUsed, durationMs,
        });
        if (++requestCounter % 10 === 0) void pruneRequestLogs();
      } catch (error) {
        console.error("[Proxy] Failed to finalize stream usage:", error);
      } finally {
        pool.trackRequestEnd(context.accountId);
      }
    })();
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamReader = stream.getReader();
      reader = streamReader;
      try {
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) break;
          observe(value);
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        return;
      } finally {
        try {
          controller.close();
        } catch {
          // The stream may already be closed/cancelled by the client.
        }
        finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        finalize();
      }
    },
  });
}

async function handleChatCompletion(body: ChatCompletionRequest, apiKeyPrincipal: ApiKeyPrincipal) {
  // Rewrite the incoming model id to its mapped target (CLI integration, e.g.
  // Claude Code's hardcoded haiku/sonnet/opus ids -> a model in the pool).
  body = { ...body, model: resolveModelAlias(normalizeModelId(body.model)) };
  const isStream = body.stream === true;
  const { result, account, provider, durationMs, compressionStats } = await routeRequest(body, isStream);
  let shouldReleaseTracking = true;

  try {
    const promptTokens = result.promptTokens || result.response?.usage?.prompt_tokens || estimateMessagesTokens(body.messages);
    const completionTokens = result.completionTokens || result.response?.usage?.completion_tokens || 0;
    const totalTokens = result.tokensUsed || result.response?.usage?.total_tokens || promptTokens + completionTokens;
    const responseUsage = result.response?.usage as {
      cached_tokens?: number;
      cache_read_input_tokens?: number;
      prompt_cache_hit_tokens?: number;
      cached_input_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      input_tokens_details?: { cached_tokens?: number };
    } | undefined;
    const cachedTokens = Number(result.cachedTokens || responseUsage?.cached_tokens || responseUsage?.cache_read_input_tokens || responseUsage?.prompt_cache_hit_tokens || responseUsage?.cached_input_tokens || responseUsage?.prompt_tokens_details?.cached_tokens || responseUsage?.input_tokens_details?.cached_tokens || 0);

  const { creditsUsed, creditSource } = computeCredits(
    provider,
    body.model,
    totalTokens,
    result.creditsUsed,
    result.creditSource
  );
    const estimatedCost = estimateCost(totalTokens, providers[provider].getProviderCreditRate(body.model));

    // Qoder: server IS the source of truth, but we now also decrement the
    // local `freeRemaining` counter optimistically for free-bucket models
    // (qmodel_latest). This gives the dashboard real-time numbers instead of
    // waiting for the next quota sync. The sync runner still overrides both
    // columns from /activity each cycle, so any local drift is self-correcting.
    const isQoder = provider === "qoder";
    const qoderProvider = providers["qoder"] as { isFreeModel?: (m: string) => boolean } | undefined;
    const useFreeCounter = isQoder && qoderProvider?.isFreeModel?.(body.model) === true;

    const quotaBefore = isQoder
      ? useFreeCounter
        ? Number(account.freeRemaining ?? 0)
        : Number(account.quotaRemaining || 0)
      : Number(account.quotaRemaining || 0);

    // For non-stream paths, decrement immediately. Stream paths and the
    // Qoder paid bucket (where we don't track usage locally) stay unchanged.
    let quotaAfter = quotaBefore;
    if (!isStream) {
      if (isQoder && useFreeCounter && quotaBefore > 0) {
        // Qoder /activity bucket charges 1 request per call regardless of token count.
        quotaAfter = await pool.decrementFreeQuota(account.id, 1);
      } else if (!isQoder && quotaBefore > 0) {
        quotaAfter = await pool.decrementQuota(account.id, creditsUsed);
      }
    }

    const logEntry = {
      accountId: account.id,
      apiKeyId: apiKeyPrincipal.id,
    accountEmail: account.email,
    provider,
    model: body.model,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    estimatedCost,
    creditsUsed,
    status: "success" as const,
    durationMs,
    requestBody: prepareLogBody({
      ...body,
      _omniark: {
        creditSource,
        creditUnit: providers[provider].getProviderCreditUnit(body.model),
        creditRate: providers[provider].getProviderCreditRate(body.model),
      },
    }),
    responseBody: prepareLogBody(result.response),
    accountQuotaBefore: quotaBefore,
    accountQuotaAfter: quotaAfter,
    compressionStats: compressionStats ?? null,
  };

    if (isStream && result.stream) {
      const [created] = await db.insert(requestLogs).values(logEntry).returning();
      const createdAt = created?.createdAt?.toISOString?.() || new Date().toISOString();

    broadcast({
      type: "request_started",
      data: { ...logEntry, id: created?.id, email: account.email, createdAt },
    });

    result.stream = wrapStreamWithUsageFinalizer(result.stream, {
      logId: created?.id,
      accountId: account.id,
      accountEmail: account.email,
      provider,
      model: body.model,
      quotaBefore,
      startedAt: Date.now() - durationMs,
      fallbackPromptTokens: promptTokens,
      fallbackCompletionTokens: completionTokens,
      fallbackTotalTokens: totalTokens,
      fallbackCreditsUsed: creditsUsed,
      fallbackCreditSource: creditSource,
      useFreeCounter,
      apiKeyPrincipal,
    });

      shouldReleaseTracking = false;
      return { result, isStream };
    }

  await db.insert(requestLogs).values(logEntry);
  await recordApiKeySuccess(apiKeyPrincipal, totalTokens);

  // Upsert to usage_summary + periodic prune
  void upsertUsageSummary({
    provider, model: body.model, status: "success",
    promptTokens, completionTokens, totalTokens, cachedTokens, estimatedCost, creditsUsed, durationMs,
  });
  if (++requestCounter % 10 === 0) void pruneRequestLogs();

  broadcast({
    type: "request_log",
    data: { ...logEntry, email: account.email, createdAt: new Date().toISOString() },
  });

    return { result, isStream };
  } finally {
    if (shouldReleaseTracking) pool.trackRequestEnd(account.id);
  }
}

/**
 * GET /v1/models - List available models
 */
proxyRouter.get("/v1/models", async (c) => {
  // Ensure BYOK cache is fresh before listing models.
  // Without this, the sync getModels() returns stale/empty supportedModels.
  await refreshByokModels();
  const principal = c.get("apiKeyPrincipal");
  const violation = await checkApiKeyPolicy(principal);
  if (violation) return c.json({ error: { message: violation.message, type: "auth_error" } }, violation.status);
  const modelAllowlist = principal.policy ? getApiKeyModelAllowlist(principal.policy) : [];
  const models = getAllModels().filter((model) => modelAllowlist.length === 0 || modelAllowlist.includes(model.id));
  return c.json({
    object: "list",
    data: models,
  });
});

/**
 * POST /v1/chat/completions - Chat completion (streaming + non-streaming)
 */
proxyRouter.post("/v1/chat/completions", async (c) => {
  let body: ChatCompletionRequest;
  try {
    body = await c.req.json<ChatCompletionRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json(openAIErrorResponse("Invalid JSON request body", 400), 400);
    }
    throw error;
  }

  // Validate request
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json(
      {
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      },
      400
    );
  }

  if (!body.model) {
    return c.json(
      {
        error: {
          message: "model is required",
          type: "invalid_request_error",
          code: "invalid_model",
        },
      },
      400
    );
  }

  body.model = normalizeModelId(body.model);
  const principal = c.get("apiKeyPrincipal");
  const violation = await checkApiKeyPolicy(principal, body.model);
  if (violation) {
    return c.json({ error: { message: violation.message, type: "insufficient_quota", code: "api_key_policy" } }, violation.status);
  }
  const isStream = body.stream === true;

  try {
    const { result } = await handleChatCompletion(body, principal);

    if (isStream && result.stream) {
      // Return SSE stream
      return new Response(result.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Return JSON response
    return c.json(result.response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const mappedModel = resolveModelAlias(normalizeModelId(body.model));

    // Log the error without masking the original proxy failure.
    const provider = pool.getProviderForModel(mappedModel) || "unknown";
    await logProxyError({
      provider,
      model: mappedModel,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody({ ...body, model: mappedModel, _omniark: { originalModel: body.model } }),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    }, "chat completion error");

    broadcast({
      type: "request_error",
      data: { model: mappedModel, error: errorMessage },
    });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);

    return c.json(
      {
        error: {
          message: errorMessage,
          type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "server_error",
          code: invalidModel ? "invalid_model" : badUpstreamRequest ? "invalid_request" : "proxy_error",
        },
      },
      invalidModel || badUpstreamRequest ? 400 : 503
    );
  }
});

/**
 * POST /v1/messages - Anthropic Messages-compatible endpoint
 */
proxyRouter.post("/v1/messages", async (c) => {
  let body: AnthropicMessagesRequest;
  try {
    body = await c.req.json<AnthropicMessagesRequest>();
  } catch (error) {
    if (isJsonParseError(error)) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON request body" } }, 400);
    }
    throw error;
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "messages is required and must be a non-empty array" } }, 400);
  }

  if (!body.model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  body.model = normalizeModelId(body.model);
  const principal = c.get("apiKeyPrincipal");
  const violation = await checkApiKeyPolicy(principal, body.model);
  if (violation) {
    return c.json({ type: "error", error: { type: "permission_error", message: violation.message } }, violation.status);
  }
  const openAIRequest = anthropicToOpenAI(body);

  try {
    const { result } = await handleChatCompletion(openAIRequest, principal);

    if (body.stream === true && result.stream) {
      return new Response(openAIStreamToAnthropic(result.stream, body), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return c.json(openAIToAnthropic(result.response, body));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const mappedModel = resolveModelAlias(normalizeModelId(body.model));
    const provider = pool.getProviderForModel(mappedModel) || "unknown";
    await logProxyError({
      provider,
      model: mappedModel,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody({ ...body, model: mappedModel, _omniark: { originalModel: body.model } }),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    }, "messages error");

    broadcast({ type: "request_error", data: { model: mappedModel, error: errorMessage } });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);
    return c.json({
      type: "error",
      error: {
        type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "api_error",
        message: errorMessage,
      },
    }, invalidModel || badUpstreamRequest ? 400 : 503);
  }
});
