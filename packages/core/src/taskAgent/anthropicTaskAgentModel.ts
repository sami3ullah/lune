/**
 * The Anthropic Task Agent model adapter (M5-01): the per-Vendor translation between
 * Lune's vendor-independent tool-calling conversation and Anthropic's native Messages
 * tool-use protocol, mirroring how `anthropicComputerUse` translates the computer tool.
 *
 * Anthropic tool calling (Messages API) is a `tool_use` conversation: the request
 * declares the tools with a JSON-Schema `input_schema`; the model replies with `text`
 * and/or `tool_use` blocks; the follow-up turn feeds each result back as a `tool_result`
 * block (in a user message) referencing that `tool_use` id. When the model replies with
 * no `tool_use`, the agent is done and its text is the final summary.
 *
 * The two pure halves - building the request from the canonical conversation, and parsing
 * a response into a {@link TaskAgentModelTurn} - are exported for unit testing; the thin
 * `generate` composes them with the injected `upstreamFetch`.
 */
import {
  DEFAULT_TASK_AGENT_MODEL_MAX_TOKENS,
  throwIfModelResponseNotOk,
  type TaskAgentModel,
  type TaskAgentModelMessage,
  type TaskAgentModelRequest,
  type TaskAgentModelTurn,
  type TaskAgentToolCall,
} from "./taskAgentModel.js";

/** The Anthropic Messages API version header value. */
export const ANTHROPIC_MESSAGES_VERSION = "2023-06-01";

/** An Anthropic content block (only the kinds this adapter produces or reads). */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** One turn of the Anthropic tool-use conversation. */
interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

/** The outbound Anthropic Messages request for one Task Agent turn. */
export interface AnthropicTaskAgentRequest {
  model: string;
  max_tokens: number;
  system: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  messages: AnthropicMessage[];
}

/** Translates the canonical conversation into Anthropic's native message list. */
function toAnthropicMessages(messages: readonly TaskAgentModelMessage[]): AnthropicMessage[] {
  return messages.map((message): AnthropicMessage => {
    if (message.role === "user") {
      return { role: "user", content: [{ type: "text", text: message.text }] };
    }
    if (message.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      if (message.text.length > 0) {
        content.push({ type: "text", text: message.text });
      }
      for (const toolCall of message.toolCalls) {
        content.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.input });
      }
      return { role: "assistant", content };
    }
    // A `tool` message becomes a user turn carrying one `tool_result` per call, which is
    // how Anthropic keeps the tool-use loop's role alternation (user/assistant/user/...).
    return {
      role: "user",
      content: message.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.toolCallId,
        content: result.output,
        ...(result.isError ? { is_error: true } : {}),
      })),
    };
  });
}

/** Builds the outbound Anthropic Messages request from a canonical tool-calling request. */
export function buildAnthropicTaskAgentRequest(request: TaskAgentModelRequest): AnthropicTaskAgentRequest {
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? DEFAULT_TASK_AGENT_MODEL_MAX_TOKENS,
    system: request.system,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    messages: toAnthropicMessages(request.messages),
  };
}

/**
 * Parses one raw Anthropic Messages response into a canonical turn: the concatenated
 * text of its `text` blocks plus one {@link TaskAgentToolCall} per `tool_use` block. No
 * tool calls means the agent is done.
 */
export function parseAnthropicTaskAgentResponse(rawJson: string): TaskAgentModelTurn {
  const parsed = JSON.parse(rawJson) as { content?: unknown };
  const contentBlocks: AnthropicContentBlock[] = Array.isArray(parsed.content)
    ? (parsed.content as AnthropicContentBlock[])
    : [];

  const text = contentBlocks
    .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls: TaskAgentToolCall[] = contentBlocks
    .filter((block): block is Extract<AnthropicContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: isRecord(block.input) ? block.input : {},
    }));

  return { text, toolCalls };
}

/** The Anthropic Task Agent model adapter: compose the pure halves with the Vendor call. */
export function createAnthropicTaskAgentModel(): TaskAgentModel {
  return {
    async generate(request: TaskAgentModelRequest): Promise<TaskAgentModelTurn> {
      const response = await request.upstreamFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": request.apiKey,
          "anthropic-version": ANTHROPIC_MESSAGES_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildAnthropicTaskAgentRequest(request)),
        signal: request.signal,
      });
      await throwIfModelResponseNotOk(response, "Anthropic");
      return parseAnthropicTaskAgentResponse(await response.text());
    },
  };
}

/** True when `value` is a plain object (a valid tool-call argument bag). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
