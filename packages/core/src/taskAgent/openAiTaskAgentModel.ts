/**
 * The OpenAI-compatible Task Agent model adapter (M5-01), serving both OpenAI and Gemini -
 * the two Vendors share one chat-completions tool-calling surface, differing only in
 * endpoint URL, display name, and the completion-limit field name (exactly the split
 * `cloudReasoningVendors` already models for the chat path).
 *
 * OpenAI tool calling is a `tool_calls` conversation: the request declares tools as
 * `{ type: "function", function: { name, description, parameters } }`; the assistant
 * message comes back with `tool_calls` whose `function.arguments` is a JSON string; the
 * follow-up feeds each result back as a `{ role: "tool", tool_call_id, content }` message.
 * No `tool_calls` in the reply means the agent is done and `content` is its summary.
 *
 * The pure request-build and response-parse halves are exported for unit testing; the
 * thin `generate` composes them with the injected `upstreamFetch`.
 */
import type { TokenLimitField } from "../reasoning/openAiWire.js";
import {
  DEFAULT_TASK_AGENT_MODEL_MAX_TOKENS,
  throwIfModelResponseNotOk,
  type TaskAgentModel,
  type TaskAgentModelMessage,
  type TaskAgentModelRequest,
  type TaskAgentModelTurn,
  type TaskAgentToolCall,
} from "./taskAgentModel.js";

/** One OpenAI-compatible tool-call in an assistant message. */
interface OpenAiWireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One OpenAI-compatible chat message this adapter produces. */
type OpenAiTaskAgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiWireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** The outbound OpenAI-compatible chat-completions request for one Task Agent turn. */
export interface OpenAiTaskAgentRequest {
  model: string;
  messages: OpenAiTaskAgentMessage[];
  tools: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  tool_choice: "auto";
  max_tokens?: number;
  max_completion_tokens?: number;
}

/** How one OpenAI-compatible Vendor differs from the other. */
export interface OpenAiTaskAgentVendorConfig {
  /** The Vendor's chat-completions endpoint. */
  chatCompletionsUrl: string;
  /** The Vendor's human-readable name (for the upstream error). */
  displayName: string;
  /** Which completion-limit field this Vendor accepts (`max_tokens` vs `max_completion_tokens`). */
  tokenLimitField: TokenLimitField;
}

/** Translates the canonical conversation into OpenAI-compatible chat messages. */
function toOpenAiMessages(messages: readonly TaskAgentModelMessage[]): OpenAiTaskAgentMessage[] {
  const openAiMessages: OpenAiTaskAgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      openAiMessages.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      const toolCalls: OpenAiWireToolCall[] = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
      }));
      openAiMessages.push({
        role: "assistant",
        // OpenAI wants `content: null` when the assistant turn is only tool calls.
        content: message.text.length > 0 ? message.text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // Each tool result is its own `role: "tool"` message referencing the call it answers.
      for (const result of message.results) {
        openAiMessages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.output });
      }
    }
  }
  return openAiMessages;
}

/** Builds the outbound OpenAI-compatible request from a canonical tool-calling request. */
export function buildOpenAiTaskAgentRequest(
  request: TaskAgentModelRequest,
  vendor: OpenAiTaskAgentVendorConfig,
): OpenAiTaskAgentRequest {
  const maxTokens = request.maxTokens ?? DEFAULT_TASK_AGENT_MODEL_MAX_TOKENS;
  return {
    model: request.model,
    // The canonical conversation has no system role; the Task Agent prompt leads as a
    // system message so every OpenAI-compatible Vendor gets the same instruction - the
    // same shape the chat path uses (`openAiRequestTranslation`).
    messages: [
      { role: "system", content: request.system },
      ...toOpenAiMessages(request.messages),
    ],
    tools: request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    tool_choice: "auto",
    [vendor.tokenLimitField]: maxTokens,
  };
}

/**
 * Parses one raw OpenAI-compatible chat-completions response into a canonical turn: the
 * assistant message's text plus one {@link TaskAgentToolCall} per `tool_calls` entry
 * (arguments JSON-parsed, defaulting to `{}` on a malformed string so a bad argument
 * blob can't crash the loop). No tool calls means the agent is done.
 */
export function parseOpenAiTaskAgentResponse(rawJson: string): TaskAgentModelTurn {
  const parsed = JSON.parse(rawJson) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  };
  const message = parsed.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";

  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: TaskAgentToolCall[] = rawToolCalls.map((rawToolCall) => {
    const toolCall = rawToolCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    return {
      id: typeof toolCall.id === "string" ? toolCall.id : "",
      name: typeof toolCall.function?.name === "string" ? toolCall.function.name : "",
      input: parseArguments(toolCall.function?.arguments),
    };
  });

  return { text, toolCalls };
}

/** Parses a tool-call `arguments` JSON string, defaulting to `{}` on anything malformed. */
function parseArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Builds an OpenAI-compatible Task Agent model adapter for one Vendor's endpoint. */
export function createOpenAiTaskAgentModel(vendor: OpenAiTaskAgentVendorConfig): TaskAgentModel {
  return {
    async generate(request: TaskAgentModelRequest): Promise<TaskAgentModelTurn> {
      const response = await request.upstreamFetch(vendor.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(buildOpenAiTaskAgentRequest(request, vendor)),
        signal: request.signal,
      });
      await throwIfModelResponseNotOk(response, vendor.displayName);
      return parseOpenAiTaskAgentResponse(await response.text());
    },
  };
}
