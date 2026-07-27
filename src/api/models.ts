import { Hono } from "hono";
import { routeRequest } from "../proxy/router";
import { getAllModels } from "../proxy/providers/registry";

export const modelsRouter = new Hono();

modelsRouter.post("/:model/test", async (c) => {
  const model = decodeURIComponent(c.req.param("model"));
  const knownModel = getAllModels().some((item) => item.id === model);
  if (!knownModel) return c.json({ success: false, error: "Model not found" }, 404);

  try {
    const routed = await routeRequest({
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
    }, false);

    const response = routed.result.response;
    const text = response?.choices?.[0]?.message?.content;
    return c.json({
      success: true,
      model,
      provider: routed.provider,
      account: routed.account.email,
      latencyMs: routed.durationMs,
      response: typeof text === "string" ? text : "Response received",
    });
  } catch (error) {
    return c.json({
      success: false,
      model,
      error: error instanceof Error ? error.message : "Upstream test failed",
    }, 502);
  }
});
