import { Hono } from "hono";
import { routeRequest } from "../proxy/router";
import { getAllModels } from "../proxy/providers/registry";
import { recordRequest } from "../proxy/index";
import { pool } from "../proxy/pool";
import { prepareLogBody } from "../proxy/logging";
import { broadcast } from "../ws/index";

export const modelsRouter = new Hono();

modelsRouter.post("/:model/test", async (c) => {
  const model = decodeURIComponent(c.req.param("model"));
  const knownModel = getAllModels().some((item) => item.id === model);
  if (!knownModel) return c.json({ success: false, error: "Model not found" }, 404);

  const provider = pool.getProviderForModel(model) || "unknown";
  const requestBody = prepareLogBody({
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 1,
    _omniark: { requestType: "model_upstream_test" },
  });
  const startedAt = Date.now();

  broadcast({
    type: "request_started",
    data: {
      provider,
      model,
      status: "pending",
      requestBody,
      createdAt: new Date(startedAt).toISOString(),
    },
  });

  try {
    const routed = await routeRequest({
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
    }, false);

    const response = routed.result.response;
    const text = response?.choices?.[0]?.message?.content;
    const promptTokens = routed.result.promptTokens || response?.usage?.prompt_tokens || 0;
    const completionTokens = routed.result.completionTokens || response?.usage?.completion_tokens || 0;
    const totalTokens = routed.result.tokensUsed || response?.usage?.total_tokens || promptTokens + completionTokens;
    await recordRequest({
      accountId: routed.account.id,
      accountEmail: routed.account.email,
      provider: routed.provider,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      creditsUsed: routed.result.creditsUsed || 0,
      status: "success",
      durationMs: routed.durationMs,
      requestBody,
      responseBody: prepareLogBody(response),
      accountQuotaBefore: Number(routed.account.quotaRemaining || 0),
      accountQuotaAfter: Number(routed.account.quotaRemaining || 0),
    });
    return c.json({
      success: true,
      model,
      provider: routed.provider,
      account: routed.account.email,
      latencyMs: routed.durationMs,
      response: typeof text === "string" ? text : "Response received",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Upstream test failed";
    await recordRequest({
      provider,
      model,
      status: "error",
      errorMessage,
      durationMs: Date.now() - startedAt,
      requestBody,
      responseBody: prepareLogBody({ error: errorMessage }),
    });
    broadcast({ type: "request_error", data: { provider, model, error: errorMessage } });
    return c.json({
      success: false,
      model,
      error: errorMessage,
    }, 502);
  }
});
