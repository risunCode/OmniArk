import type { ChatCompletionRequest } from "../base";

export interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface CodexStreamContext {
  extractReasoningDelta(event: any): string;
  textFromReasoningPart(part: any): string;
  extractReasoningItemText(item: any): string;
  collectCompletedToolCalls(response: any, byIndex: Map<number, PendingToolCall>): void;
  estimateTokens(text: string): number;
  estimateMessagesTokens(messages: ChatCompletionRequest["messages"]): number;
  generateId(): string;
}

export interface CodexParseResult {
  text: string;
  reasoningText: string;
  inputTokens: number;
  outputTokens: number;
  toolCallsByIndex: Map<number, PendingToolCall>;
}

function extractDataLine(event: string): string | null {
  let dataLine = "";
  for (const line of event.split("\n")) {
    if (line.startsWith("data: ")) dataLine += line.slice(6);
    else if (line.startsWith("data:")) dataLine += line.slice(5);
  }
  return dataLine && dataLine !== "[DONE]" ? dataLine : null;
}

export function extractReasoningDelta(event: any): string {
  const type = event?.type || "";
  if (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta"
  ) {
    return typeof event.delta === "string" ? event.delta : "";
  }
  return "";
}

export function textFromReasoningPart(part: any): string {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (typeof part.text === "string") return part.text;
  if (typeof part.summary_text === "string") return part.summary_text;
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) {
    return part.content
      .map((inner: any) => textFromReasoningPart(inner))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function extractReasoningItemText(item: any): string {
  if (item?.type !== "reasoning") return "";
  const parts = [item.summary, item.content, item.text, item.reasoning].flatMap((value) => {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  });
  return parts.map((part) => textFromReasoningPart(part)).filter(Boolean).join("\n");
}

export function collectCompletedToolCalls(
  response: any,
  byIndex: Map<number, PendingToolCall>,
) {
  for (const [index, item] of (response?.output || []).entries()) {
    if (item?.type !== "function_call") continue;
    byIndex.set(index, {
      index,
      id: item.call_id || item.id || `call_${index}`,
      name: item.name || "",
      arguments: item.arguments || "",
    });
  }
}

function ensureToolCall(
  byIndex: Map<number, PendingToolCall>,
  index: number,
  defaults: Partial<PendingToolCall> = {},
): PendingToolCall {
  const existing = byIndex.get(index);
  if (existing) return existing;
  const created: PendingToolCall = {
    index,
    id: defaults.id || `call_${index}`,
    name: defaults.name || "",
    arguments: defaults.arguments || "",
  };
  byIndex.set(index, created);
  return created;
}

export async function parseCodexResponsesSSE(
  body: ReadableStream<Uint8Array>,
  ctx: CodexStreamContext,
): Promise<CodexParseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoningText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCallsByIndex = new Map<number, PendingToolCall>();
  const reasoningByOutput = new Map<number, string>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const dataLine = extractDataLine(event);
      if (!dataLine) continue;

      try {
        const obj = JSON.parse(dataLine);
        const t = obj.type || "";
        const reasoningDelta = ctx.extractReasoningDelta(obj);

        if (reasoningDelta) {
          const index = Number(obj.output_index ?? 0);
          reasoningByOutput.set(index, `${reasoningByOutput.get(index) || ""}${reasoningDelta}`);
          reasoningText += reasoningDelta;
        } else if (
          t === "response.reasoning_summary_text.done" ||
          t === "response.reasoning_summary_part.done"
        ) {
          const index = Number(obj.output_index ?? 0);
          const doneText = typeof obj.text === "string" ? obj.text : ctx.textFromReasoningPart(obj.part);
          if (doneText && !reasoningByOutput.get(index)) {
            reasoningByOutput.set(index, doneText);
            reasoningText += doneText;
          }
        } else if (t === "response.output_text.delta") {
          text += obj.delta || "";
        } else if (t === "response.output_item.added" || t === "response.output_item.done") {
          const item = obj.item || {};
          if (item.type === "reasoning") {
            const index = Number(obj.output_index ?? 0);
            const itemText = ctx.extractReasoningItemText(item);
            if (itemText && !reasoningByOutput.get(index)) {
              reasoningByOutput.set(index, itemText);
              reasoningText += itemText;
            }
          } else if (item.type === "function_call") {
            const index = Number(obj.output_index ?? toolCallsByIndex.size);
            toolCallsByIndex.set(index, {
              index,
              id: item.call_id || item.id || `call_${index}`,
              name: item.name || "",
              arguments: item.arguments || toolCallsByIndex.get(index)?.arguments || "",
            });
          }
        } else if (t === "response.function_call_arguments.delta") {
          const index = Number(obj.output_index ?? 0);
          const current = ensureToolCall(toolCallsByIndex, index, {
            id: obj.call_id,
            name: obj.name,
          });
          current.arguments += obj.delta || "";
        } else if (t === "response.function_call_arguments.done") {
          const index = Number(obj.output_index ?? 0);
          const current = ensureToolCall(toolCallsByIndex, index, {
            id: obj.call_id,
            name: obj.name,
          });
          current.arguments = obj.arguments || current.arguments;
        } else if (t === "response.completed") {
          ctx.collectCompletedToolCalls(obj.response, toolCallsByIndex);
          const usage = obj.response?.usage;
          if (usage) {
            inputTokens = Number(usage.input_tokens) || 0;
            outputTokens = Number(usage.output_tokens) || 0;
          }
        }
      } catch {
        /* skip malformed */
      }
    }
  }

  return { text, reasoningText, inputTokens, outputTokens, toolCallsByIndex };
}

export function convertCodexResponsesToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  id: string,
  model: string,
  ctx: Pick<CodexStreamContext, "extractReasoningDelta" | "textFromReasoningPart" | "extractReasoningItemText" | "collectCompletedToolCalls">,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let started = false;
      let accumulated = "";
      let hasToolCalls = false;
      const toolCallsByIndex = new Map<number, PendingToolCall>();
      const emittedToolIndexes = new Set<number>();
      const reasoningByOutput = new Map<number, string>();

      const emit = (delta: any, finish_reason: string | null = null) => {
        const chunk: any = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };

      const emitRole = () => {
        if (started) return;
        started = true;
        emit({ role: "assistant" });
      };

      const emitToolStart = (call: PendingToolCall) => {
        emitRole();
        hasToolCalls = true;
        emittedToolIndexes.add(call.index);
        emit({
          tool_calls: [{
            index: call.index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: "" },
          }],
        });
      };

      const emitToolArguments = (index: number, delta: string) => {
        if (!delta) return;
        emitRole();
        hasToolCalls = true;
        emit({
          tool_calls: [{
            index,
            function: { arguments: delta },
          }],
        });
      };

      const emitReasoning = (index: number, delta: string) => {
        if (!delta) return;
        emitRole();
        reasoningByOutput.set(index, `${reasoningByOutput.get(index) || ""}${delta}`);
        emit({ reasoning_content: delta });
      };

      const emitMissingCompletedToolCalls = () => {
        for (const pending of [...toolCallsByIndex.values()].sort((a, b) => a.index - b.index)) {
          if (!pending.name) continue;
          if (!emittedToolIndexes.has(pending.index)) {
            emitToolStart(pending);
            emitToolArguments(pending.index, pending.arguments || "{}");
          }
        }
      };

      const closeStream = (finishReason: string) => {
        emit({}, finishReason);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const dataLine = extractDataLine(event);
            if (!dataLine) continue;

            try {
              const obj = JSON.parse(dataLine);
              const t = obj.type || "";
              const reasoningDelta = ctx.extractReasoningDelta(obj);

              if (reasoningDelta) {
                emitReasoning(Number(obj.output_index ?? 0), reasoningDelta);
              } else if (
                t === "response.reasoning_summary_text.done" ||
                t === "response.reasoning_summary_part.done"
              ) {
                const index = Number(obj.output_index ?? 0);
                const doneText = typeof obj.text === "string" ? obj.text : ctx.textFromReasoningPart(obj.part);
                if (doneText && !reasoningByOutput.get(index)) {
                  emitReasoning(index, doneText);
                }
              } else if (t === "response.output_text.delta") {
                const delta = obj.delta || "";
                if (!delta) continue;
                emitRole();
                accumulated += delta;
                emit({ content: delta });
              } else if (t === "response.output_item.added" || t === "response.output_item.done") {
                const item = obj.item || {};
                if (item.type === "reasoning") {
                  const index = Number(obj.output_index ?? 0);
                  const itemText = ctx.extractReasoningItemText(item);
                  if (itemText && !reasoningByOutput.get(index)) {
                    emitReasoning(index, itemText);
                  }
                } else if (item.type === "function_call") {
                  const index = Number(obj.output_index ?? toolCallsByIndex.size);
                  const current = toolCallsByIndex.get(index) || {
                    index,
                    id: item.call_id || item.id || `call_${index}`,
                    name: item.name || "",
                    arguments: "",
                  };
                  current.id = item.call_id || item.id || current.id;
                  current.name = item.name || current.name;
                  current.arguments = item.arguments || current.arguments;
                  toolCallsByIndex.set(index, current);
                  if (current.name && !emittedToolIndexes.has(index)) {
                    emitToolStart(current);
                    if (current.arguments) emitToolArguments(index, current.arguments);
                  }
                }
              } else if (t === "response.function_call_arguments.delta") {
                const index = Number(obj.output_index ?? 0);
                const current = ensureToolCall(toolCallsByIndex, index, {
                  id: obj.call_id,
                  name: obj.name,
                });
                current.arguments += obj.delta || "";
                toolCallsByIndex.set(index, current);
                emitToolArguments(index, obj.delta || "");
              } else if (t === "response.function_call_arguments.done") {
                const index = Number(obj.output_index ?? 0);
                const current = ensureToolCall(toolCallsByIndex, index, {
                  id: obj.call_id,
                  name: obj.name,
                });
                const previousLength = current.arguments.length;
                current.arguments = obj.arguments || current.arguments;
                toolCallsByIndex.set(index, current);
                if (!emittedToolIndexes.has(index) && current.name) emitToolStart(current);
                if (current.arguments.length > previousLength && previousLength === 0) {
                  emitToolArguments(index, current.arguments);
                }
              } else if (t === "response.completed" || t === "response.done") {
                ctx.collectCompletedToolCalls(obj.response, toolCallsByIndex);
                emitMissingCompletedToolCalls();
                closeStream(hasToolCalls ? "tool_calls" : "stop");
                return;
              } else if (t === "response.failed" || t === "error") {
                closeStream("stop");
                return;
              }
            } catch {
              /* skip malformed */
            }
          }
        }

        if (!started) emit({ role: "assistant", content: accumulated });
        emitMissingCompletedToolCalls();
        closeStream(hasToolCalls ? "tool_calls" : "stop");
      } catch (err) {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      }
    },
  });
}
