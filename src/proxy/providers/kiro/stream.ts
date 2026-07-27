import type { ProviderResult } from "../base";
import {
  concatBytes,
  readEventStreamFrames,
  unwrapKiroEvent,
  extractReasoningText,
  extractEventText,
  isCompleteJson,
  completeJsonSuffix,
  extractKiroContextTokens,
  extractKiroCredits,
} from "./aws-eventstream";

export interface CreateKiroLiveStreamOptions {
  response: Response;
  model: string;
  id: string;
  contextWindow: number;
}

export function createKiroLiveStream(options: CreateKiroLiveStreamOptions): ProviderResult {
  const { response, model, id, contextWindow } = options;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const reader = response.body?.getReader();
      if (!reader) { controller.close(); return; }
      let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      const toolIndexes = new Map<string, number>();
      const toolBuffers = new Map<string, string>();
      const toolInputObjects = new Map<string, Record<string, unknown>>();
      let nextToolIndex = 0;
      const allEvents: Array<{ headers: Record<string, string>; payload: any }> = [];
      let streamedContentLength = 0;

      const enqueue = (delta: any, finish_reason: string | null = null, usage?: any) => {
        const chunk: any = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason }],
        };
        if (usage) chunk.usage = usage;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };

      try {
        enqueue({ role: "assistant" });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = concatBytes(buffer, value as Uint8Array);
          const parsed = readEventStreamFrames(buffer);
          buffer = parsed.remaining;
          for (const event of parsed.events) {
            allEvents.push(event);
            const eventType = event.headers[":event-type"];
            const payload = unwrapKiroEvent(event.payload, eventType);
            if (event.headers[":message-type"] === "error" || event.headers[":message-type"] === "exception") {
              throw new Error(typeof payload === "string" ? payload : payload?.message || event.headers[":error-code"] || "Kiro stream error");
            }
            const reasoning = extractReasoningText(payload, eventType);
            if (reasoning) enqueue({ reasoning_content: reasoning });
            const text = extractEventText(payload, eventType);
            if (text) { streamedContentLength += text.length; enqueue({ content: text }); }
            const tool = payload?.toolUseEvent || (eventType === "toolUseEvent" ? payload : null);
            if (tool?.toolUseId && (tool?.name || toolIndexes.has(tool.toolUseId))) {
              const isFirstChunk = !toolIndexes.has(tool.toolUseId);
              if (isFirstChunk && !tool.name) {
                // Can't start a tool call without a name — skip
              } else {
                if (isFirstChunk) toolIndexes.set(tool.toolUseId, nextToolIndex++);
                const toolIdx = toolIndexes.get(tool.toolUseId)!;

                // Kiro sends tool.input as either a string fragment or a full object.
                // For objects: accumulate into toolInputObjects and only stringify on stop.
                // For strings: accumulate as raw string fragments (OpenAI streaming style).
                let args = "";
                if (typeof tool.input === "string") {
                  args = tool.input;
                } else if (tool.input && typeof tool.input === "object" && Object.keys(tool.input).length > 0) {
                  // Merge object into accumulated input for this tool
                  const prev = toolInputObjects.get(tool.toolUseId) || {};
                  const merged = { ...prev, ...tool.input };
                  toolInputObjects.set(tool.toolUseId, merged);
                  // Don't stream partial object args — wait for stop event
                  args = "";
                }

                if (isFirstChunk) {
                  toolBuffers.set(tool.toolUseId, args);
                  enqueue({
                    tool_calls: [{
                      index: toolIdx,
                      id: tool.toolUseId,
                      type: "function",
                      function: { name: tool.name, arguments: args },
                    }],
                  });
                } else if (args) {
                  toolBuffers.set(tool.toolUseId, (toolBuffers.get(tool.toolUseId) || "") + args);
                  enqueue({
                    tool_calls: [{
                      index: toolIdx,
                      function: { arguments: args },
                    }],
                  });
                }

                if (tool.stop === true) {
                  // If we accumulated object input, emit the full JSON now
                  const accumulatedObj = toolInputObjects.get(tool.toolUseId);
                  if (accumulatedObj && Object.keys(accumulatedObj).length > 0) {
                    const fullArgs = JSON.stringify(accumulatedObj);
                    const prevBuffer = toolBuffers.get(tool.toolUseId) || "";
                    toolBuffers.set(tool.toolUseId, prevBuffer + fullArgs);
                    enqueue({
                      tool_calls: [{
                        index: toolIdx,
                        function: { arguments: fullArgs },
                      }],
                    });
                  } else {
                    // String-mode: check if JSON is complete
                    const buffered = toolBuffers.get(tool.toolUseId) || "";
                    if (buffered && !isCompleteJson(buffered)) {
                      const suffix = completeJsonSuffix(buffered);
                      if (suffix) {
                        enqueue({
                          tool_calls: [{
                            index: toolIdx,
                            function: { arguments: suffix },
                          }],
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
        // Flush any accumulated object inputs that never received tool.stop
        for (const [toolId, objInput] of toolInputObjects.entries()) {
          if (Object.keys(objInput).length === 0) continue;
          const prevBuffer = toolBuffers.get(toolId) || "";
          // Only emit if we haven't already flushed (check if buffer already has valid JSON)
          if (prevBuffer && isCompleteJson(prevBuffer)) continue;
          const toolIdx = toolIndexes.get(toolId);
          if (toolIdx === undefined) continue;
          const fullArgs = JSON.stringify(objInput);
          toolBuffers.set(toolId, prevBuffer + fullArgs);
          enqueue({
            tool_calls: [{
              index: toolIdx,
              function: { arguments: fullArgs },
            }],
          });
        }

        // Extract real usage from Kiro's contextUsageEvent and meteringEvent
        const totalTokens = extractKiroContextTokens(allEvents, contextWindow);
        const creditsUsed = extractKiroCredits(allEvents);
        const completionTokens = Math.max(1, Math.ceil(streamedContentLength / 4));
        const promptTokens = totalTokens > completionTokens ? totalTokens - completionTokens : 0;
        const usage = totalTokens > 0 || creditsUsed > 0
          ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, credits_used: creditsUsed }
          : undefined;
        enqueue({}, toolIndexes.size > 0 ? "tool_calls" : "stop", usage);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return { success: true, stream, tokensUsed: 0 };
}
