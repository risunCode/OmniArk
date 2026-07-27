import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatCompletionRequest } from "../base";

export const CHAT_URL =
  "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

// Business descriptors sent in body.business.
// CLI uses product=cli, type=agent. Required for the server to attribute
// the request to the right billing/promo bucket.
const BUSINESS_PRODUCT = "cli";
const BUSINESS_TYPE = "agent";
const BUSINESS_VERSION = "1.0.22"; // matches Cosy-Version

export interface QoderModelDef {
  id: string;           // proxy-facing ID (qd-*)
  upstream: string;     // server-side model key
  display_name: string;
  max_input_tokens: number;
  is_vl: boolean;
  is_reasoning: boolean;
  price_factor: number;
}

export const QODER_MODELS: QoderModelDef[] = [
  { id: "qd-Auto",              upstream: "auto",          display_name: "Auto",              max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 1 },
  { id: "qd-Ultimate",          upstream: "ultimate",      display_name: "Ultimate",          max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 1.6 },
  { id: "qd-Performance",       upstream: "performance",   display_name: "Performance",       max_input_tokens: 272000, is_vl: true,  is_reasoning: false, price_factor: 1.1 },
  { id: "qd-Efficient",         upstream: "efficient",     display_name: "Efficient",         max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.3 },
  { id: "qd-Lite",              upstream: "lite",          display_name: "Lite",              max_input_tokens: 180000, is_vl: false, is_reasoning: false, price_factor: 0 },
  // Qwen3.7-Max accepts up to 1M-token context windows. Qodercli's default
  // `max_input_tokens: 180000` is just the lowest tier the picker offers —
  // the server itself accepts much larger windows (the CLI lets users opt
  // in to 200k / 400k / 1M from settings.json `model.contextWindow`).
  // Advertise the full 1M here so downstream clients (Cline, Roo, Claude
  // Code) don't trim history before we even reach Qoder. The server will
  // reject requests it actually can't serve, which is the right place to
  // enforce the real ceiling.
  { id: "qd-Qwen3.7-Max",       upstream: "qmodel_latest", display_name: "Qwen3.7-Max",       max_input_tokens: 1000000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
  { id: "qd-Qwen3.6-Plus",      upstream: "qmodel",        display_name: "Qwen3.6-Plus",      max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
  { id: "qd-DeepSeek-V4-Pro",   upstream: "dmodel",        display_name: "DeepSeek-V4-Pro",   max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 0.5 },
  { id: "qd-DeepSeek-V4-Flash", upstream: "dfmodel",       display_name: "DeepSeek-V4-Flash", max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 0.1 },
  { id: "qd-GLM-5.1",           upstream: "gm51model",     display_name: "GLM-5.1",           max_input_tokens: 180000, is_vl: true,  is_reasoning: true,  price_factor: 0.6 },
  { id: "qd-Kimi-K2.6",         upstream: "kmodel",        display_name: "Kimi-K2.6",         max_input_tokens: 256000, is_vl: true,  is_reasoning: false, price_factor: 0.3 },
  { id: "qd-MiniMax-M2.7",      upstream: "mmodel",        display_name: "MiniMax-M2.7",      max_input_tokens: 180000, is_vl: true,  is_reasoning: false, price_factor: 0.2 },
];

export const MODEL_CONFIGS: Record<string, QoderModelDef> = Object.fromEntries(
  QODER_MODELS.map((m) => [m.id, m]),
);

let CACHED_TEMPLATE: any = null;
function loadTemplate(): any {
  if (CACHED_TEMPLATE) return CACHED_TEMPLATE;
  try {
    const filePath = path.join(__dirname, "../qoder-baseprompt.json");
    let raw = fs.readFileSync(filePath, "utf8");
    raw = raw.replace(/\{UUID[1-5]\}/g, () => crypto.randomUUID());
    raw = raw.replace(/\{TIME1\}/g, String(Date.now()));
    CACHED_TEMPLATE = JSON.parse(raw);
  } catch (e) {
    CACHED_TEMPLATE = null;
  }
  return CACHED_TEMPLATE;
}

function extractLatestUserPrompt(request: ChatCompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = (msg.content as any[]).find((b) => b?.type === "text")?.text;
      if (typeof text === "string" && text) return text;
    }
  }
  return "";
}

function extractLatestUserImages(request: ChatCompletionRequest): any[] {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (!msg || msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    const images: any[] = [];
    for (const b of msg.content as any[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "image_url" || b.type === "image") {
        images.push(normalizeImageBlock(b));
      }
    }
    if (images.length > 0) return images;
  }
  return [];
}

function normalizeImageBlock(block: any): any {
  // OpenAI format: { type: "image_url", image_url: { url: "..." } }
  if (block.type === "image_url" && block.image_url?.url) {
    return block; // already in OpenAI format
  }
  // Anthropic format: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
  if (block.type === "image" && block.source?.type === "base64") {
    const { media_type, data } = block.source;
    return {
      type: "image_url",
      image_url: {
        url: `data:${media_type};base64,${data}`,
      },
    };
  }
  // Fallback: return as-is
  return block;
}

export function buildQoderMessages(request: ChatCompletionRequest, templateMessages: any[] | undefined, hasIncomingTools: boolean): any[] {
  const incomingHasSystem = request.messages.some((m) => m.role === "system");
  const result: any[] = [];

  if (hasIncomingTools && !incomingHasSystem) {
    // Build detailed tool descriptions with schemas for better guidance
    const toolDescriptions = (request.tools || [])
      .map((t: any) => {
        const name = t?.function?.name || t?.name;
        const desc = t?.function?.description || t?.description || "No description";
        const params = t?.function?.parameters?.properties || t?.parameters?.properties || {};
        const paramNames = Object.keys(params);
        const paramInfo = paramNames.length > 0
          ? ` Parameters: ${paramNames.join(", ")}`
          : "";
        return `- ${name}: ${desc}${paramInfo}`;
      })
      .filter(Boolean)
      .join("\n");

    const toolNames = (request.tools || [])
      .map((t: any) => t?.function?.name || t?.name)
      .filter(Boolean)
      .join(", ");

    result.push({
      role: "system",
      content: `You are a helpful assistant with access to the following tools:

${toolDescriptions}

## Tool Usage Guidelines:

1. **When to use tools**: When the user's request requires information retrieval, file operations, code execution, or any action that these tools can perform, you MUST call the appropriate tool. Do not say you cannot help; instead, invoke the tool with the correct arguments.

2. **Trust tool results**: After calling a tool, you will receive the tool result in the conversation. The tool result contains the actual data or outcome of the tool execution. Use this information to formulate your response. Do not claim you didn't receive file contents or data if the tool result was provided.

3. **Multi-turn workflows**: For complex tasks requiring multiple tool calls:
   - Call tools sequentially as needed
   - Use information from previous tool results to inform subsequent calls
   - Only respond with your final answer after you have gathered all necessary information

4. **Error handling**: If a tool returns an error or empty result, acknowledge this to the user and suggest alternatives or next steps.

5. **Text-only responses**: Only respond with plain text (without tool calls) when:
   - No available tool can address the user's request
   - You already have all the information needed from previous tool results
   - The user is asking for clarification or a simple answer

Available tools: ${toolNames}`,
    });
  } else if (!hasIncomingTools && !incomingHasSystem) {
    // Do NOT pull system messages from the Qoder-CLI template — they put
    // the model in "Qoder CLI agent" mode (TodoWrite-everything, Windows
    // hardcoded paths, "verify your output" loops, etc.) which causes
    // off-topic repetition for plain chat. Add a neutral, minimal system
    // prompt instead so the model just acts as a helpful assistant.
    result.push({
      role: "system",
      content: "You are a helpful AI assistant. Answer the user's questions clearly and concisely. Maintain context from earlier turns in the conversation.",
    });
  }

  for (const m of request.messages) {
    // Handle assistant messages with tool_calls (OpenAI format)
    if (m.role === "assistant" && (m as any).tool_calls) {
      const toolCalls = (m as any).tool_calls.map((tc: any) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function?.name || "",
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {}),
        },
      }));

      const content = typeof m.content === "string" ? m.content : "";
      result.push({
        role: "assistant",
        content,
        contents: content ? [{ type: "text", text: content }] : [],
        tool_calls: toolCalls,
      });
      continue;
    }

    if (typeof m.content === "string") {
      const msg: any = { role: m.role, content: m.content, contents: [{ type: "text", text: m.content }] };
      // Preserve tool_call_id for OpenAI tool messages
      if (m.role === "tool" && (m as any).tool_call_id) {
        msg.tool_call_id = (m as any).tool_call_id;
      }
      result.push(msg);
      continue;
    }
    if (Array.isArray(m.content)) {
      const blocks = m.content as any[];
      const textParts: string[] = [];
      const imageParts: any[] = [];
      const toolCalls: any[] = [];
      const toolResults: { tool_call_id: string; content: string }[] = [];

      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "image_url" || b.type === "image") {
          imageParts.push(normalizeImageBlock(b));
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
            },
          });
        } else if (b.type === "tool_result") {
          let content = "";
          if (typeof b.content === "string") {
            content = b.content;
          } else if (Array.isArray(b.content)) {
            content = (b.content as any[])
              .map((inner) => (inner?.type === "text" && typeof inner.text === "string" ? inner.text : ""))
              .filter(Boolean)
              .join("\n");
          }
          if (b.is_error) content = `[ERROR] ${content}`;
          toolResults.push({ tool_call_id: b.tool_use_id, content });
        }
      }

      const textContent = textParts.join("\n");

      // Build contents array (Qoder native format) — text + images
      const contentsArr: any[] = [];
      if (textContent) contentsArr.push({ type: "text", text: textContent });
      contentsArr.push(...imageParts);

      if (m.role === "assistant" && toolCalls.length > 0) {
        const msg: any = { role: "assistant", content: textContent, contents: [{ type: "text", text: textContent }] };
        msg.tool_calls = toolCalls;
        result.push(msg);
        continue;
      }

      if (m.role === "user" && toolResults.length > 0) {
        for (const tr of toolResults) {
          result.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
        }
        if (contentsArr.length > 0) {
          result.push({ role: "user", content: textContent, contents: contentsArr });
        }
        continue;
      }

      result.push({ role: m.role, content: textContent, contents: contentsArr });
      continue;
    }
    result.push({ role: m.role, content: "", contents: [] });
  }

  return result;
}

/**
 * Derive a stable session_id from a conversation's ANCHOR (the parts that
 * don't change as the conversation grows).
 *
 * Qoder server uses session_id as the key for server-side persisted
 * conversation state (context, tool call records, compaction boundaries).
 * The session_id MUST stay constant across every turn of the same chat —
 * otherwise the server treats each turn as a brand-new conversation, the
 * model "forgets" prior context, and answers loop or repeat themselves.
 *
 * Bug we're fixing: the previous implementation hashed ALL messages, so
 * every new turn (with one more message appended) produced a different
 * session_id. Effectively: every turn = new session = no memory.
 *
 * Fix: hash only the conversation ANCHOR — everything that's stable across
 * turns:
 *   1. All system messages (system prompts don't change mid-conversation)
 *   2. The FIRST user message (the conversation opener)
 *
 * The first user turn is the natural fingerprint of "which conversation
 * is this." Two different chats almost never start with identical opener
 * text, so collisions are rare; the same chat always rehashes to the same
 * value because the anchor never changes.
 */
function deriveSessionId(messages: ChatCompletionRequest["messages"]): string {
  const hash = crypto.createHash("sha256");
  let firstUserSeen = false;

  const updateWithContent = (content: unknown) => {
    if (typeof content === "string") {
      hash.update(content);
    } else if (Array.isArray(content)) {
      for (const block of content as any[]) {
        if (block?.type === "text" && typeof block.text === "string") {
          hash.update(block.text);
        }
      }
    }
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      hash.update("system:");
      updateWithContent(msg.content);
      hash.update("\n");
    } else if (msg.role === "user" && !firstUserSeen) {
      hash.update("user:");
      updateWithContent(msg.content);
      hash.update("\n");
      firstUserSeen = true;
      // Stop here — anything after the first user message is volatile
      // (the assistant's reply, follow-up turns) and would destabilize
      // the session_id as the conversation grows.
      break;
    }
  }

  // Edge case: no user message yet (e.g. system-only probe). Fall back to
  // hashing the role sequence so probes still get deterministic IDs.
  if (!firstUserSeen) {
    hash.update("__no_user__");
  }

  const hex = hash.digest("hex").slice(0, 32);
  // Format as valid UUID v4
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildChatBody(request: ChatCompletionRequest): any {
  const prompt = extractLatestUserPrompt(request);
  const images = extractLatestUserImages(request);
  const cfg = MODEL_CONFIGS[request.model] || QODER_MODELS[0]!;
  const reqId = crypto.randomUUID();
  const chatRecordId = crypto.randomUUID();
  const sessionId = deriveSessionId(request.messages);
  const hasIncomingTools = Array.isArray(request.tools) && request.tools.length > 0;

  const template = loadTemplate();
  const body: any = template ? JSON.parse(JSON.stringify(template)) : {};

  body.request_id = reqId;
  body.chat_record_id = chatRecordId;
  body.request_set_id = crypto.randomUUID();
  body.session_id = sessionId;
  body.stream = true;
  // Qodercli 1.0.22 sends "" here (NOT "personal_standard"). Mirror that
  // exactly — server uses this together with userType in the JWT to decide
  // billing routing, and a non-empty value here appears to send the request
  // down a path that bypasses the qmodel_latest free-quota bucket.
  body.aliyun_user_type = "";

  if (!body.model_config) body.model_config = {};
  body.model_config.key = cfg.upstream;
  body.model_config.display_name = cfg.display_name;
  body.model_config.is_vl = cfg.is_vl;
  body.model_config.is_reasoning = cfg.is_reasoning;
  body.model_config.max_input_tokens = cfg.max_input_tokens;
  body.model_config.format = body.model_config.format || "openai";
  body.model_config.source = body.model_config.source || "system";

  // Business object — qodercli 1.0.22 shape. Server reads product/type/stage
  // to attribute the request to the right billing bucket. Without these, the
  // request is served but does NOT charge against the qmodel_latest free
  // quota.
  body.business = {
    product: BUSINESS_PRODUCT,
    version: BUSINESS_VERSION,
    type: BUSINESS_TYPE,
    id: crypto.randomUUID(),
    name: prompt.slice(0, 30),
    begin_at: Date.now(),
    stage: "start",
  };

  if (!body.chat_context) body.chat_context = {};
  body.chat_context.text = { type: "text", text: prompt };
  if (images.length > 0) {
    body.chat_context.images = images;
    // Also set imageUrls at chat_context level (some Qoder endpoints check this)
    body.chat_context.imageUrls = images.map((img: any) => img.image_url?.url).filter(Boolean);
  }
  if (!body.chat_context.extra) body.chat_context.extra = {};
  body.chat_context.extra.originalContent = { type: "text", text: prompt };
  if (images.length > 0) {
    body.chat_context.extra.images = images;
  }
  if (!body.chat_context.extra.modelConfig) body.chat_context.extra.modelConfig = {};
  body.chat_context.extra.modelConfig.key = cfg.upstream;
  body.chat_context.extra.modelConfig.is_reasoning = cfg.is_reasoning;

  // Set top-level image_urls (Qoder API also checks this field)
  if (images.length > 0) {
    body.image_urls = images.map((img: any) => img.image_url?.url).filter(Boolean);
  }

  body.messages = buildQoderMessages(request, body.messages, hasIncomingTools);

  // Mirror messages[0] system prompt up to top-level body.system. Qodercli
  // 1.0.22 sends BOTH locations identically — server reads top-level `system`
  // for billing/routing decisions while messages[0] feeds the model.
  const sysMsg = body.messages.find((m: any) => m?.role === "system");
  if (sysMsg && typeof sysMsg.content === "string") {
    body.system = sysMsg.content;
  }

  if (request.max_tokens && body.parameters) {
    body.parameters.max_tokens = request.max_tokens;
  }

  // ALWAYS override `body.tools` from the request — never inherit the
  // template's Qoder-CLI tool list (Bash/BashOutput/Edit/etc). If the
  // client didn't send tools, send none. Inheriting template tools makes
  // the model hallucinate tool calls the client cannot execute, which
  // surfaces as repeated/looping responses (model keeps "trying" a tool
  // that never returns a result).
  if (hasIncomingTools) {
    body.tools = request.tools;
  } else {
    body.tools = [];
  }

  return body;
}

/**
 * Generate OpenAI-style tool call ID.
 * OpenAI uses format: "call_" + 24 alphanumeric characters
 */
function generateOpenAIToolId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'call_';
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Normalize tool call ID to OpenAI format.
 * OpenAI uses simple alphanumeric IDs like "call_abc123...", not Anthropic's "toolu_*" format.
 * If the upstream ID is too short, generate a new one.
 */
export function normalizeToolCallId(id: string | undefined, index: number): string {
  if (!id) {
    // Generate OpenAI-style ID if none provided
    return generateOpenAIToolId();
  }
  // Strip Anthropic prefix if present (for compatibility)
  if (id.startsWith("toolu_")) {
    id = id.slice(6);
  }
  // If ID is too short (< 20 chars after stripping), generate a new one
  if (id.length < 20) {
    return generateOpenAIToolId();
  }
  return id;
}

export interface ToolCallAcc {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParsedDelta {
  role?: string;
  content?: string;
  reasoningContent?: string;
  toolCalls?: any[];
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function parseSseLine(line: string): ParsedDelta | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const wrapper = JSON.parse(data);
    const innerStr = wrapper.body;
    if (typeof innerStr !== "string" || !innerStr) return null;
    if (innerStr === "[DONE]") return null;
    const inner = JSON.parse(innerStr);
    const result: ParsedDelta = {};

    if (inner.usage) {
      result.usage = {
        prompt_tokens: Number(inner.usage.prompt_tokens) || 0,
        completion_tokens: Number(inner.usage.completion_tokens) || 0,
        total_tokens: Number(inner.usage.total_tokens) || 0,
      };
    }

    const choice = inner.choices?.[0];
    if (!choice) {
      return result.usage ? result : null;
    }
    const delta = choice.delta || {};
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    if (typeof delta.role === "string") result.role = delta.role;
    if (typeof delta.content === "string") result.content = delta.content;
    if (typeof delta.reasoning_content === "string") result.reasoningContent = delta.reasoning_content;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      result.toolCalls = delta.tool_calls;
    }
    return result;
  } catch {
    return null;
  }
}
