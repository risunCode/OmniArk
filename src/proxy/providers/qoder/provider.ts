import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "../base";
import type { Account } from "../../../db/schema";
import * as crypto from "node:crypto";
import {
  type QoderTokens,
  type QoderActivitySnapshot,
  type JobTokenResponse,
  type ActivityResponse,
  openApiHeaders,
  bearerFetch,
  exchangeJobToken,
  generateMachineIdentity,
  QOTA_USAGE_URL,
  ACTIVITY_URL,
} from "./protocol";
import {
  CHAT_URL,
  QODER_MODELS,
  MODEL_CONFIGS,
  buildChatBody,
  parseSseLine,
  normalizeToolCallId,
  type ToolCallAcc,
} from "./chat";

// ============================================================================
// Qoder CLI port — auth + chat (PAT/COSY flow, no browser cookie)
// Reverse-engineered from github.com/cubk1/qoder2api (Java) + qodercli bundle.
// ============================================================================

export class QoderProvider extends BaseProvider {
  name = "qoder";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("qd-");
  }

  supportedModels: ModelInfo[] = QODER_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "qoder",
    context_window: m.max_input_tokens,
    max_output: 64000,
    thinking: m.is_reasoning,
    vision: m.is_vl,
    creditUnit: "credit" as const,
    creditRate: (0.004 * Math.max(0.001, m.price_factor)) / 1000,
    creditSource: "estimated" as const,
  }));

  private parseTokens(account: Account): QoderTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      if (!t || typeof t !== "object" || !t.personalToken) return null;
      // Backfill missing machine identity. Older imports (pre 1.0.22 fix)
      // wrote tokens without machineId/Token/Type. The cosy-machine* headers
      // depend on these — without them the request is served but appears to
      // skip the qmodel_latest free-quota bucket. Generate stable values now
      // so all subsequent requests carry valid headers.
      if (!t.machineId) t.machineId = crypto.randomUUID();
      if (!t.machineToken) t.machineToken = t.machineId; // CLI: token == id
      if (!t.machineType) t.machineType = "5"; // CLI literal client type
      return t as QoderTokens;
    } catch {
      return null;
    }
  }

  private async ensureFreshAuth(tokens: QoderTokens): Promise<{ tokens: QoderTokens; refreshed: boolean }> {
    const now = Date.now();
    const needsRefresh =
      !tokens.securityOauthToken ||
      !tokens.userId ||
      (tokens.expireTime && tokens.expireTime - 60_000 < now);

    if (!needsRefresh) return { tokens, refreshed: false };

    const jt = await exchangeJobToken(tokens);
    if (!jt.id) {
      throw new Error("jobToken response missing user id");
    }

    const updated: QoderTokens = {
      ...tokens,
      userId: jt.id,
      userName: jt.name || tokens.userName || "",
      securityOauthToken: jt.securityOauthToken || tokens.securityOauthToken || "",
      refreshToken: jt.refreshToken || tokens.refreshToken || "",
      userType: jt.userType || tokens.userType || "personal_standard",
      plan: jt.plan || tokens.plan,
      expireTime: jt.expireTime || tokens.expireTime,
      email: jt.email || tokens.email,
    };
    return { tokens: updated, refreshed: true };
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const result = await this.chatCompletionStream(account, request);
    if (!result.success || !result.stream) return result;

    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    const toolCalls: ToolCallAcc[] = [];
    let finishReason: string | null = null;
    let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          if (line === "data: [DONE]") continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            // Extract usage from final chunk (has empty choices array)
            if (chunk.usage && chunk.usage.total_tokens > 0) {
              finalUsage = {
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
                cached_tokens: Number(chunk.usage.cached_tokens || chunk.usage.cache_read_input_tokens || chunk.usage.prompt_cache_hit_tokens || chunk.usage.prompt_tokens_details?.cached_tokens || 0),
              };
            }
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) fullContent += delta.content;
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? toolCalls.length;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { index: idx, id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
            if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Fall back to estimation if upstream didn't report usage
    if (finalUsage.total_tokens === 0) {
      const estimated = this.estimateMessagesTokens(request.messages);
      finalUsage = { prompt_tokens: estimated, completion_tokens: this.estimateTokens(fullContent), total_tokens: estimated + this.estimateTokens(fullContent), cached_tokens: 0 };
    }

    const filledToolCalls = toolCalls.filter((t) => t && t.id);
    const response: ChatCompletionResponse = {
      id: this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: fullContent || "",
          ...(filledToolCalls.length > 0 ? { tool_calls: filledToolCalls } : {}),
        },
        finish_reason: finishReason || (filledToolCalls.length > 0 ? "tool_calls" : "stop"),
      }],
      usage: finalUsage,
    };

    return {
      ...result,
      success: true,
      response,
      stream: undefined,
      tokensUsed: finalUsage.total_tokens,
      promptTokens: finalUsage.prompt_tokens,
      completionTokens: finalUsage.completion_tokens,
      cachedTokens: finalUsage.cached_tokens,
    };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) {
      return { success: false, error: "No personalToken available" };
    }

    let tokens: QoderTokens;
    let refreshed = false;
    try {
      const auth = await this.ensureFreshAuth(parsed);
      tokens = auth.tokens;
      refreshed = auth.refreshed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `expired: ${msg}` };
    }

    const body = buildChatBody(request);
    let resp: Response;
    try {
      const cfg = MODEL_CONFIGS[request.model] || QODER_MODELS[0]!;
      const modelSource = body?.model_config?.source || "system";
      resp = await bearerFetch(tokens, {
        url: CHAT_URL,
        body,
        stream: true,
        extraHeaders: {
          "x-model-key": cfg.upstream,
          "x-model-source": modelSource,
        },
      });
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (resp.status === 401) {
      return { success: false, error: `expired: HTTP 401` };
    }
    if (resp.status === 403) {
      return { success: false, error: "Rate limited or quota exceeded", quotaExhausted: true };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: `Qoder chat HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    if (!resp.body) {
      return { success: false, error: "Qoder response missing body" };
    }

    const upstream = resp.body;
    const id = this.generateId();
    const model = request.model;
    const encoder = new TextEncoder();

    // Track usage across the stream — will be emitted in final chunk
    let accumulatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sentRole = false;
        let finishEmitted = false;
        const toolIndex = new Map<string, number>();
        let nextToolIdx = 0;
        const pendingToolCalls = new Map<number, { id: string; function: { name: string; arguments: string } }>();
        let lastActivity = Date.now();
        const STREAM_TIMEOUT = 300000; // 5 minutes
        let streamActive = true;

        const enqueue = (delta: any, finishReason: string | null = null, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number }) => {
          if (!streamActive) {
            return; // Skip enqueue if stream is already closed
          }
          try {
            const chunk: any = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            };
            // Include usage in the finish chunk per OpenAI spec
            if (usage) {
              chunk.usage = usage;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch (e) {
            // Controller closed or error - mark stream as inactive
            streamActive = false;
            console.log(`[Qoder] Stream enqueue failed (client likely disconnected): ${e instanceof Error ? e.message : String(e)}`);
          }
        };

        try {
          while (streamActive) {
            // Check timeout
            if (Date.now() - lastActivity > STREAM_TIMEOUT) {
              console.error(`[Qoder] Stream timeout after ${STREAM_TIMEOUT}ms`);
              break;
            }

            // Use Promise.race for timeout on read
            const readPromise = reader.read();
            const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) => {
              setTimeout(() => reject(new Error("Stream read timeout")), STREAM_TIMEOUT);
            });

            let result;
            try {
              result = await Promise.race([readPromise, timeoutPromise]);
            } catch (e) {
              console.error(`[Qoder] Stream read error: ${e instanceof Error ? e.message : String(e)}`);
              break;
            }

            if (result.done) break;
            lastActivity = Date.now();

            buffer += decoder.decode(result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const raw of lines) {
              const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
              if (!line) continue;

              // Detect Qoder error responses in SSE body (HTTP 200 but error in JSON)
              // Format: {"code":"112","statusCodeValue":403,"message":"..."}
              if (line.startsWith("data:")) {
                const dataStr = line.slice(5).trim();
                if (dataStr && dataStr !== "[DONE]") {
                  try {
                    const wrapper = JSON.parse(dataStr);
                    const svc = wrapper.statusCodeValue;
                    if (svc && svc >= 400) {
                      const errStatus = wrapper.statusCode || "";
                      let errMsg = wrapper.message || "";
                      if (typeof errMsg === "string" && errMsg.startsWith("{")) {
                        try { const p = JSON.parse(errMsg); errMsg = p.pricingUrl || JSON.stringify(p); } catch {}
                      }
                      const fullErr = `Qoder HTTP ${svc} ${errStatus}: ${errMsg.slice(0, 200) || "rate limited or quota exceeded"}`;
                      console.error(`[Qoder] ${fullErr}`);
                      // Send error signal to stream, finalizer will detect and mark exhausted
                      try {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "upstream_error", error: fullErr })}\n\n`));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                      } catch {}
                      streamActive = false;
                      finishEmitted = true;
                      break;
                    }
                  } catch {}
                }
              }

              const parsedDelta = parseSseLine(line);
              if (!parsedDelta) continue;

              // Track usage from upstream (usually in final chunk)
              if (parsedDelta.usage) {
                accumulatedUsage = {
                  ...parsedDelta.usage,
                  cached_tokens: parsedDelta.usage.cached_tokens || 0,
                };
              }

              // Build delta object, combining role with first content (OpenAI spec)
              const delta: any = {};

              if (!sentRole) {
                // Include role in the first chunk that has any content
                if (parsedDelta.reasoningContent || parsedDelta.content || parsedDelta.toolCalls) {
                  delta.role = "assistant";
                  sentRole = true;
                }
              }

              if (parsedDelta.reasoningContent) {
                delta.reasoning_content = parsedDelta.reasoningContent;
              }

              if (parsedDelta.content) {
                delta.content = parsedDelta.content;
              }

              if (parsedDelta.toolCalls) {
                const remapped: any[] = [];
                for (const tc of parsedDelta.toolCalls) {
                  const key = typeof tc.index === "number" ? `idx-${tc.index}` : (tc.id || `tool-${nextToolIdx}`);
                  let idx = toolIndex.get(key);
                  if (idx === undefined) {
                    idx = nextToolIdx++;
                    toolIndex.set(key, idx);
                    pendingToolCalls.set(idx, { id: "", function: { name: "", arguments: "" } });
                    // Generate stable ID once per tool call (not per chunk)
                    const stableId = normalizeToolCallId(tc.id, idx);
                    pendingToolCalls.get(idx)!.id = stableId;
                  }
                  // Use stable ID from pendingToolCalls (consistent across chunks)
                  const stableId = pendingToolCalls.get(idx)!.id;
                  if (tc.function?.name) pendingToolCalls.get(idx)!.function.name = tc.function.name;
                  if (tc.function?.arguments) pendingToolCalls.get(idx)!.function.arguments += tc.function.arguments;
                  remapped.push({
                    index: idx,
                    id: stableId,
                    ...(tc.type ? { type: tc.type } : { type: "function" }),
                    ...(tc.function ? { function: tc.function } : {}),
                  });
                }
                delta.tool_calls = remapped;
              }

              // Only enqueue if delta has content (not empty)
              if (Object.keys(delta).length > 0) {
                enqueue(delta);
              }

              if (parsedDelta.finishReason) {
                // Include usage in the finish chunk (OpenAI spec)
                enqueue({}, parsedDelta.finishReason, accumulatedUsage.total_tokens > 0 ? accumulatedUsage : undefined);
                finishEmitted = true;
              }
            }
          }

          if (!finishEmitted && streamActive) {
            // Include usage in the final stop chunk per OpenAI spec
            enqueue({}, "stop", accumulatedUsage.total_tokens > 0 ? accumulatedUsage : undefined);
          }

          if (streamActive) {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (e) {
              streamActive = false;
            }
          }
        } catch (error) {
          streamActive = false;
          const msg = error instanceof Error ? error.message : String(error);
          // Don't log client disconnects as errors
          if (msg.includes("cancelled") || msg.includes("aborted") || msg.includes("closed")) {
            console.log(`[Qoder] Stream ${msg}`);
          } else {
            console.error(`[Qoder] Stream error: ${msg}`);
          }
          // Try to send error to client (if stream still open)
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: "api_error" } })}\n\n`));
          } catch {
            // Controller already closed, ignore
          }
        } finally {
          streamActive = false;
          try { controller.close(); } catch {}
          try { reader.releaseLock(); } catch {}
        }
      },
    });

    return {
      success: true,
      stream,
      tokensUsed: accumulatedUsage.total_tokens,
      promptTokens: accumulatedUsage.prompt_tokens,
      completionTokens: accumulatedUsage.completion_tokens,
      cachedTokens: accumulatedUsage.cached_tokens,
      ...(refreshed ? { tokens: JSON.stringify(tokens) } : {}),
    };
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) return { success: false, error: "No personalToken" };
    try {
      const { tokens } = await this.ensureFreshAuth({ ...parsed, securityOauthToken: "", userId: "" });
      return { success: true, tokens: JSON.stringify(tokens) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const t = this.parseTokens(account);
    return !!t?.personalToken;
  }

  /**
   * Whether a given Qoder model id is covered by a Free-promo bucket on
   * `/activity`. Currently only `qmodel_latest` (Qwen3.7-Max) has a promo;
   * other models hit the account-wide credit pool from `/quota/usage`.
   *
   * Used by the proxy to route per-request decrement to the correct counter.
   */
  isFreeModel(modelId: string): boolean {
    const def = MODEL_CONFIGS[modelId];
    return def?.upstream === "qmodel_latest";
  }

  /**
   * Verify whether a Qoder account is *actually* quota-exhausted by probing the
   * cheapest model (`qd-Lite`, price_factor=0). Live request 403s are noisy:
   * rate limits, signature replay, transient auth issues all surface as 403.
   * Use this before flipping status to `exhausted` so we don't poison accounts
   * that can still serve requests.
   *
   * Returns:
   *   - true  → probe definitively says quota is exhausted (mark exhausted)
   *   - false → probe succeeded or failed transiently (don't mark, retry later)
   */
  async probeQuotaExhausted(account: Account): Promise<boolean> {
    try {
      const probe = await this.chatCompletion(account, {
        model: "qd-Lite",
        messages: [{ role: "user", content: "OK" }],
        max_tokens: 4,
      });
      // Probe succeeded → account is alive. Don't poison.
      if (probe.success) return false;
      // Probe explicitly says quota exhausted → trust it.
      if (probe.quotaExhausted) return true;
      // Anything else (transient, network, auth) — treat as inconclusive.
      return false;
    } catch {
      // Throwing means we can't verify — be conservative, don't mark.
      return false;
    }
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) return { success: false, error: "No personalToken" };

    try {
      const { tokens } = await this.ensureFreshAuth(parsed);
      if (!tokens.securityOauthToken) {
        return { success: false, error: "No securityOauthToken after refresh" };
      }

      const resp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(tokens.securityOauthToken),
      });

      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: `Qoder quota rejected (${resp.status})` };
      }
      if (!resp.ok) {
        return { success: false, error: `Qoder quota HTTP ${resp.status}` };
      }

      const data = (await resp.json()) as {
        userQuota?: { total?: number; used?: number; remaining?: number };
        expiresAt?: number;
        isQuotaExceeded?: boolean;
      };

      const limit = Number(data.userQuota?.total) || 0;
      const used = Number(data.userQuota?.used) || 0;
      const remaining = Number(data.userQuota?.remaining ?? Math.max(0, limit - used));
      const resetAt = data.expiresAt ? new Date(data.expiresAt) : null;

      return { success: true, quota: { limit, remaining, used, resetAt } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Fetch per-model promo quotas (e.g. Qwen3.7-Max 200/day) from
   * `/algo/api/v2/activity`. COSY-signed GET — same auth as chat calls.
   *
   * Best-effort: callers should treat failures as non-fatal and fall back to
   * the account-wide `quota/usage` data.
   */
  private async fetchActivityQuota(tokens: QoderTokens): Promise<QoderActivitySnapshot> {
    const resp = await bearerFetch(tokens, { url: ACTIVITY_URL, method: "GET" });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`activity HTTP ${resp.status}: ${text.slice(0, 120)}`);
    }
    const data = (await resp.json()) as ActivityResponse;
    if (data.code !== 0) {
      throw new Error(`activity code=${data.code} msg=${data.msg ?? "unknown"}`);
    }
    return {
      activities: Array.isArray(data.data?.activities) ? data.data!.activities! : [],
      queryAt: Number(data.data?.queryAt ?? Date.now()),
      fetchedAt: new Date().toISOString(),
    };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const parsed = this.parseTokens(account);
    if (!parsed?.personalToken) {
      return { kind: "missing_tokens", success: false, error: "No personalToken" };
    }

    let tokens: QoderTokens;
    let refreshed = false;
    try {
      const auth = await this.ensureFreshAuth(parsed);
      tokens = auth.tokens;
      refreshed = auth.refreshed;
    } catch (error) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!tokens.securityOauthToken) {
      return { kind: "session_expired", success: false, error: "No securityOauthToken after refresh" };
    }

    // ---- Account-wide credit (the "All" bar) ----
    let result: ProviderHealthResult;
    try {
      const resp = await fetch(QOTA_USAGE_URL, {
        method: "GET",
        headers: openApiHeaders(tokens.securityOauthToken),
      });

      if (resp.status === 401 || resp.status === 403) {
        return { kind: "session_expired", success: false, error: `Qoder rejected (${resp.status})` };
      }
      if (!resp.ok) {
        return { kind: "transient_error", success: false, retryable: true, error: `Qoder HTTP ${resp.status}` };
      }

      const data = (await resp.json()) as {
        userQuota?: { total?: number; used?: number; remaining?: number };
        expiresAt?: number;
        isQuotaExceeded?: boolean;
      };

      const limit = Number(data.userQuota?.total) || 0;
      const used = Number(data.userQuota?.used) || 0;
      const remaining = Number(data.userQuota?.remaining ?? Math.max(0, limit - used));
      const resetAt = data.expiresAt ? new Date(data.expiresAt) : undefined;

      // 0/0 quota (limit=0, remaining=0) means the API doesn't report meaningful
      // quota data — not that the account is truly exhausted. Only treat as
      // exhausted if the API explicitly flags it OR remaining went negative OR
      // there's a real quota (limit>0) that hit zero.
      const exceeded = data.isQuotaExceeded === true || (remaining < 0) || (remaining <= 0 && limit > 0);
      const quota = { limit, remaining, used, resetAt, source: "qoder.openapi" };

      result = {
        kind: exceeded ? "exhausted" : "healthy",
        success: true,
        quota,
        ...(refreshed ? { tokens } : {}),
      };
    } catch (error) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // ---- Per-model promo quota (the "Free" bar) — best-effort enrichment ----
    // We deliberately swallow errors here: a flaky activity endpoint must not
    // poison an otherwise-healthy account. Failures are recorded as a
    // breadcrumb in metadata for observability.
    try {
      const activity = await this.fetchActivityQuota(tokens);
      result.metadata = { ...(result.metadata || {}), activityQuota: activity };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.metadata = {
        ...(result.metadata || {}),
        activityQuotaError: msg.slice(0, 200),
      };
    }

    return result;
  }
}

// ============================================================================
// Public helpers (used by accounts API for add-account flow)
// ============================================================================

export async function activateQoderPat(personalToken: string): Promise<{ tokens: QoderTokens; jobToken: JobTokenResponse }> {
  const machine = generateMachineIdentity();
  const seed: QoderTokens = {
    personalToken,
    machineId: machine.machineId,
    machineToken: machine.machineToken,
    machineType: machine.machineType,
  };
  const jt = await exchangeJobToken(seed);
  if (!jt.id) throw new Error("Qoder jobToken response missing id");
  const tokens: QoderTokens = {
    ...seed,
    userId: jt.id,
    userName: jt.name || "",
    securityOauthToken: jt.securityOauthToken || "",
    refreshToken: jt.refreshToken || "",
    userType: jt.userType || "personal_standard",
    plan: jt.plan,
    expireTime: jt.expireTime,
    email: jt.email,
  };
  return { tokens, jobToken: jt };
}
