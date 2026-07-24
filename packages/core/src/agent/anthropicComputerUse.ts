/**
 * The Anthropic computer-use adapter (DECISIONS #14-15): the per-Vendor translation
 * between Anthropic's native computer-use tool protocol and Lune's vendor-independent
 * canonical Action / conversation, mirroring how the SSE adapters translate transport
 * for a chat turn.
 *
 * Everything here is pure over its inputs (no network, no clock, no session storage),
 * so the two things that actually need proving - building the outbound Anthropic
 * request and parsing an Anthropic response into a canonical Action - are unit-testable
 * in isolation. The HTTP call, session storage, and gating live in the Screen Agent
 * Capability above this.
 *
 * Anthropic's computer use (Messages API) works as a tool-use conversation: the
 * request declares a `computer` tool sized to the display; the model replies with a
 * `tool_use` block whose `input.action` is the operation to perform (`left_click`
 * with a `coordinate`, `type` with `text`, `key`, `scroll`, `screenshot`, ...); the
 * follow-up turn feeds the resulting screenshot back as a `tool_result` referencing
 * that `tool_use` id. When the model stops requesting the tool and just replies with
 * text, the goal is done.
 *
 * Carried from v1's Sidecar (`agent/anthropicComputerUse.ts`), unchanged in behaviour.
 */
import type { AgentAction, ConsequenceLevel } from "./agentAction.js";
import { escalateConsequence } from "./agentAction.js";
import { readNumberArg, readStringArg, readScrollDirectionArg } from "./agentArgReaders.js";
import { AGENT_SYSTEM_PROMPT } from "./agentSystemPrompt.js";
import {
  throwIfStepResponseNotOk,
  type AgentDisplay,
  type AgentScreenshot,
  type ComputerUseStepInput,
  type ComputerUseStepResult,
  type ComputerUseVendorAdapter,
} from "./computerUseAdapter.js";

export type { AgentDisplay, AgentScreenshot };

/** An Anthropic message content block (only the kinds this adapter produces/reads). */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: AnthropicContentBlock[] };

/** One turn of the accumulating Anthropic computer-use conversation. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

/** The outbound Anthropic Messages request for one Agent Step. */
export interface AnthropicComputerUseRequest {
  model: string;
  max_tokens: number;
  system: string;
  tools: Array<Record<string, unknown>>;
  messages: AnthropicMessage[];
}

/**
 * The result of parsing one Anthropic computer-use response: the canonical Action to
 * return to the Shell, the assistant content to append to the conversation for
 * continuity, and (unless the Session is done) the `tool_use` id the next Step's
 * `tool_result` must reference.
 */
export interface AnthropicComputerUseStep {
  action: AgentAction;
  assistantContent: AnthropicContentBlock[];
  pendingToolUseId?: string;
}

/** The Anthropic Messages API version header value. */
export const ANTHROPIC_MESSAGES_VERSION = "2023-06-01";
/** The computer-use beta header value the Messages API requires for the computer tool. */
export const ANTHROPIC_COMPUTER_USE_BETA = "computer-use-2025-01-24";
/** The computer tool type matching the beta above. */
const ANTHROPIC_COMPUTER_TOOL_TYPE = "computer_20250124";
/** A generous per-step token budget for the model's tool-use decision. */
const AGENT_STEP_MAX_TOKENS = 1024;

/** Builds the first user turn: the spoken goal plus the first screenshot. */
export function initialUserMessage(goal: string, screenshot: AgentScreenshot): AnthropicMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: goal },
      imageBlock(screenshot),
    ],
  };
}

/**
 * Builds the follow-up user turn: the screenshot resulting from the previous Action,
 * fed back as the `tool_result` for the pending `tool_use`. This is what closes the
 * observe->act->observe loop across Steps.
 */
export function toolResultMessage(
  pendingToolUseId: string,
  screenshot: AgentScreenshot,
): AnthropicMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: pendingToolUseId,
        content: [imageBlock(screenshot)],
      },
    ],
  };
}

/** Builds the outbound Anthropic Messages request from the accumulated conversation. */
export function buildAnthropicComputerUseRequest(options: {
  messages: AnthropicMessage[];
  model: string;
  display: AgentDisplay;
  systemPrompt: string;
}): AnthropicComputerUseRequest {
  const { messages, model, display, systemPrompt } = options;
  return {
    model,
    max_tokens: AGENT_STEP_MAX_TOKENS,
    system: systemPrompt,
    tools: [
      {
        type: ANTHROPIC_COMPUTER_TOOL_TYPE,
        name: "computer",
        display_width_px: display.width,
        display_height_px: display.height,
        // A Session is bound to one active display; acting is single-display.
        display_number: 1,
      },
    ],
    messages,
  };
}

/**
 * Parses one raw Anthropic Messages response into a canonical Action plus the
 * continuity data the session needs. If the model emitted a `tool_use` for the
 * computer tool, its `input.action` is translated into the matching canonical Action;
 * if it emitted only text (no tool call), the goal is done and the text becomes the
 * final spoken summary.
 */
export function parseAnthropicComputerUseResponse(rawJson: string): AnthropicComputerUseStep {
  const parsed = JSON.parse(rawJson) as {
    content?: unknown;
  };
  const contentBlocks: AnthropicContentBlock[] = Array.isArray(parsed.content)
    ? (parsed.content as AnthropicContentBlock[])
    : [];

  const toolUse = contentBlocks.find(
    (block): block is Extract<AnthropicContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use",
  );

  if (toolUse === undefined) {
    // No tool call: the model is done and its text is the spoken summary.
    return {
      action: { kind: "done", finalText: concatenateText(contentBlocks) },
      assistantContent: contentBlocks,
    };
  }

  return {
    action: translateComputerToolUse(toolUse.input),
    assistantContent: contentBlocks,
    pendingToolUseId: toolUse.id,
  };
}

/**
 * Translates one Anthropic `computer` tool `input` into a canonical Action. The
 * Consequence Level is resolved through the escalate-only combinator so the floor
 * plugs in; today Anthropic emits no per-Action risk tag, so the model tag is
 * `benign` and the floor here is `benign` (the Capability applies the real floor).
 */
function translateComputerToolUse(input: Record<string, unknown>): AgentAction {
  const action = typeof input.action === "string" ? input.action : "";
  const consequence: ConsequenceLevel = escalateConsequence("benign", "benign");

  switch (action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
    case "mouse_click": {
      const [x, y] = readCoordinate(input.coordinate);
      return { kind: "click", x, y, consequence };
    }
    case "type": {
      return { kind: "type", text: readStringArg(input.text), consequence };
    }
    case "key": {
      return { kind: "key", combo: readStringArg(input.text), consequence };
    }
    case "scroll": {
      const [x, y] = readCoordinate(input.coordinate);
      return {
        kind: "scroll",
        x,
        y,
        direction: readScrollDirectionArg(input.scroll_direction),
        amount: readNumberArg(input.scroll_amount),
        consequence,
      };
    }
    default:
      // `screenshot`, `wait`, `cursor_position`, `mouse_move`, and any action we do
      // not (yet) execute all resolve to a no-op observe: the Shell just captures the
      // screen again and the loop continues. Defaulting unknowns to observe is
      // fail-safe - it never performs an OS action we did not explicitly map.
      return { kind: "observe", consequence };
  }
}

/** Concatenates the text of a response's text blocks into the spoken summary. */
function concatenateText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** An Anthropic base64 image content block for a screenshot. */
function imageBlock(screenshot: AgentScreenshot): AnthropicContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: screenshot.mediaType, data: screenshot.base64Data },
  };
}

/** Reads an `[x, y]` coordinate array, defaulting to the origin on any malformed value. */
function readCoordinate(value: unknown): [number, number] {
  if (Array.isArray(value) && value.length >= 2) {
    return [readNumberArg(value[0]), readNumberArg(value[1])];
  }
  return [0, 0];
}

/** The Anthropic adapter's own conversation state, persisted between Steps. */
interface AnthropicAdapterState {
  /** The full Anthropic conversation so far, including assistant tool-use turns. */
  messages: AnthropicMessage[];
  /** The `tool_use` id the next Step's screenshot must be returned against. */
  pendingToolUseId: string;
}

/**
 * The Anthropic computer-use adapter (DECISIONS #14-15): composes the pure translation
 * above with the injected `upstreamFetch` to advance the Session one Step. It starts a
 * new conversation from the goal on the first Step, and on later Steps feeds the fresh
 * screenshot back as the `tool_result` for the pending `tool_use`.
 */
export function createAnthropicComputerUseAdapter(): ComputerUseVendorAdapter {
  return {
    vendorId: "anthropic",
    // Claude chat models drive the computer-use tool, so the advisory Model Slot doubles
    // as the acting model - no dedicated model needed.
    usesAdvisoryModelSlot: true,
    async step(input: ComputerUseStepInput): Promise<ComputerUseStepResult> {
      const priorState = input.priorState as AnthropicAdapterState | undefined;

      const messages: AnthropicMessage[] =
        priorState === undefined
          ? [initialUserMessage(input.goal ?? "", input.screenshot)]
          : [...priorState.messages, toolResultMessage(priorState.pendingToolUseId, input.screenshot)];

      const request = buildAnthropicComputerUseRequest({
        messages,
        model: input.model,
        display: input.display,
        systemPrompt: AGENT_SYSTEM_PROMPT,
      });

      const response = await input.upstreamFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": input.apiKey,
          "anthropic-version": ANTHROPIC_MESSAGES_VERSION,
          "anthropic-beta": ANTHROPIC_COMPUTER_USE_BETA,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });

      await throwIfStepResponseNotOk(response, "Anthropic");

      const parsed = parseAnthropicComputerUseResponse(await response.text());
      if (parsed.action.kind === "done") {
        return { action: parsed.action, nextState: undefined };
      }

      const advancedMessages = [
        ...messages,
        { role: "assistant" as const, content: parsed.assistantContent },
      ];
      return {
        action: parsed.action,
        nextState: {
          messages: advancedMessages,
          // A non-done Anthropic step always came from a tool_use, so its id is set;
          // fall back defensively to the prior id rather than persisting an empty one.
          pendingToolUseId: parsed.pendingToolUseId ?? priorState?.pendingToolUseId ?? "",
        } satisfies AnthropicAdapterState,
      };
    },
  };
}
