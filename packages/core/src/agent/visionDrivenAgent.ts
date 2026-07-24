/**
 * The vision-driven agent adapter (M2-07): a fourth acting adapter behind the same
 * `ComputerUseVendorAdapter` seam as Anthropic/Gemini/OpenAI, but one that drives the
 * loop with the Vendor's ordinary *advisory vision chat model* (the config's Model Slot -
 * e.g. `gpt-4o`, a `gemini-*-flash`) instead of a dedicated, access-gated computer-use
 * model. The model already sees the screen and already emits coordinates; this adapter
 * asks it, one Step at a time, for a single screen Action as a strict JSON object, parses
 * that into a canonical `AgentAction`, and hands it to the exact same Shell loop.
 *
 * Why it exists: OpenAI's `computer_use_preview` tool is org-verification-gated (a real
 * M2-06 field blocker - "Tool 'computer_use_preview' is not supported" = the key lacks
 * access), and Gemini's dedicated computer-use model is a second model to key and route.
 * But a general vision model is enough to locate a target, decide click/type/scroll, and
 * stop when done - all the Screen Agent needs - so acting works the moment chat does, on
 * the same key and the same Model Slot. Nothing below the seam changes: the canonical
 * Action, the escalate-only Consequence floor, the Confirm Gate, and the guardrails are
 * untouched.
 *
 * Everything here is pure over its inputs (no network, no clock, no session storage), so
 * the two things that actually need proving - building the outbound chat request and
 * parsing a chat completion into a canonical Action - are unit-testable in isolation. The
 * HTTP call, session storage, and gating live in the Screen Agent Capability above this.
 *
 * Wire protocol: this adapter speaks the OpenAI-compatible *chat completions* surface
 * (OpenAI and Gemini both expose it - the same surface the advisory Reasoning path uses),
 * one non-streaming request per Step:
 *   - the request carries the Screen Agent system prompt (which teaches the JSON action
 *     grammar and the coordinate space), the accumulated conversation, and the latest
 *     screenshot as an `image_url` content part;
 *   - `response_format: { type: "json_object" }` asks the Vendor to return valid JSON,
 *     and the parser is tolerant on top (it strips code fences / surrounding prose) so a
 *     Vendor that ignores the hint still parses;
 *   - the model replies with one JSON object naming the action; `{ "action": "done" }`
 *     is the terminal Step and its `finalText` is the spoken summary;
 *   - coordinates come back in full-resolution display-pixel space (v1 sends the
 *     full-resolution screenshot and states the display dimensions), so no remap is
 *     needed - the seam's existing contract.
 *
 * Consequence tagging: the grammar's `consequence` field is the model's own risk tag,
 * folded through the escalate-only combinator exactly like OpenAI's native
 * `pending_safety_checks`; the Capability's `applyConsequenceFloor` (with the M2-05 AX
 * target signal) still runs on top, so a model that under-flags a send/delete/pay/submit
 * cannot slip it past the Confirm Gate.
 *
 * Session continuity: the opaque `priorState` is the accumulated chat history (the goal,
 * the model's prior action objects, and the follow-up observations). Only the *latest*
 * screenshot is kept - prior screenshots are stripped to their text on each Step - to
 * bound token cost across Steps.
 */
import type { AgentAction, ConsequenceLevel } from "./agentAction.js";
import { escalateConsequence } from "./agentAction.js";
import { readKeyComboArg, readNumberArg, readScrollDirectionArg, readStringArg } from "./agentArgReaders.js";
import { AGENT_SYSTEM_PROMPT } from "./agentSystemPrompt.js";
import type { ComputerUseVendorId } from "./computerUseVendors.js";
import type { TokenLimitField } from "../reasoning/openAiWire.js";
import {
  GEMINI_CHAT_COMPLETIONS_URL,
  OPENAI_CHAT_COMPLETIONS_URL,
} from "../reasoning/cloudReasoningVendors.js";
import {
  throwIfStepResponseNotOk,
  type AgentDisplay,
  type AgentScreenshot,
  type ComputerUseStepInput,
  type ComputerUseStepResult,
  type ComputerUseVendorAdapter,
} from "./computerUseAdapter.js";

export type { AgentDisplay, AgentScreenshot };

/** A chat message content part (text or image); mirrors the OpenAI-compatible wire shape. */
export type VisionChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** One turn of the accumulating vision-chat conversation (system is prepended at build). */
export interface VisionChatMessage {
  role: "user" | "assistant";
  /** A bare string (the model's prior action JSON) or a parts array (text + screenshot). */
  content: string | VisionChatContentPart[];
}

/** A request message: the accumulated turns plus the leading `system` persona turn. */
export interface VisionChatRequestMessage {
  role: "system" | "user" | "assistant";
  content: string | VisionChatContentPart[];
}

/** The outbound non-streaming chat request for one Agent Step. */
export interface VisionAgentChatRequest {
  model: string;
  messages: VisionChatRequestMessage[];
  /** Ask the Vendor for a valid JSON object; the parser is tolerant regardless. */
  response_format: { type: "json_object" };
  /** The completion budget, under whichever field name the Vendor accepts (OpenAI vs Gemini). */
  max_tokens?: number;
  max_completion_tokens?: number;
}

/**
 * A per-Vendor descriptor for driving the OpenAI-compatible chat surface. Only OpenAI and
 * Google/Gemini expose it, so the vision-driven adapter is wired for those two; the
 * endpoint constants are shared with the advisory chat path (`reasoning/cloudReasoningVendors`)
 * so the two never drift.
 */
export interface VisionDrivenVendorConfig {
  vendorId: ComputerUseVendorId;
  /** Human-readable name, for the typed upstream error. */
  displayName: string;
  /** The OpenAI-compatible chat-completions endpoint. */
  chatCompletionsUrl: string;
  /** Which completion-limit field this Vendor accepts (OpenAI reasoning families differ). */
  tokenLimitField: TokenLimitField;
}

/**
 * The wired vision-driven Vendors: the two that expose an OpenAI-compatible chat surface.
 * (Anthropic acts through its native computer-use tool, which already runs on the chat
 * slot, so it has no vision-driven variant here.)
 */
export const VISION_DRIVEN_VENDORS: Record<"openai" | "google", VisionDrivenVendorConfig> = {
  openai: {
    vendorId: "openai",
    displayName: "OpenAI",
    chatCompletionsUrl: OPENAI_CHAT_COMPLETIONS_URL,
    // OpenAI's reasoning families (o-series, GPT-5+) reject `max_tokens`.
    tokenLimitField: "max_completion_tokens",
  },
  google: {
    vendorId: "google",
    displayName: "Google Gemini",
    chatCompletionsUrl: GEMINI_CHAT_COMPLETIONS_URL,
    // Gemini's OpenAI-compatible surface takes the classic `max_tokens`.
    tokenLimitField: "max_tokens",
  },
};

/**
 * A generous per-Step completion budget: a reasoning model spends hidden reasoning tokens
 * against the same limit before the (small) JSON object, so a tight budget could return an
 * empty completion. The visible answer is one short JSON object regardless.
 */
const AGENT_STEP_MAX_TOKENS = 2048;

/**
 * The Screen Agent vision prompt: the shared acting persona plus this path's JSON action
 * grammar and coordinate space. The display dimensions are interpolated so returned
 * coordinates are already in display-pixel space (no remap), matching the seam's contract.
 */
export function buildVisionAgentSystemPrompt(display: AgentDisplay): string {
  return [
    AGENT_SYSTEM_PROMPT,
    "",
    "You do not have a computer-use tool. Reply with exactly one JSON object describing",
    "the single next action - no prose, no markdown, no code fences, only the object.",
    "",
    `The screen is ${display.width}x${display.height} pixels. The origin (0,0) is the`,
    "top-left corner; x increases to the right, y increases downward. Give every",
    "coordinate in these screen pixels.",
    "",
    "Fields:",
    '  "action": one of "click", "type", "key", "scroll", "copy", "observe", "done".',
    '  "x", "y": the target point in screen pixels (for "click", "scroll", and an',
    '            optional click-before-type on "type").',
    '  "text": the text to type (for "type") or to place on the clipboard (for "copy").',
    '  "combo": the key combo, e.g. "cmd+s" or "return" (for "key").',
    '  "direction": "up" | "down" | "left" | "right" (for "scroll").',
    '  "amount": how far to scroll (for "scroll").',
    '  "pressEnter": true to press Return after typing (for "type").',
    '  "consequence": "consequential" when the action sends, deletes, pays, submits,',
    '                 buys, overwrites, or navigates away irreversibly; otherwise "benign".',
    '  "finalText": a short spoken summary (for "done").',
    "",
    'Use "observe" to look again without touching anything. Emit "done" when the goal is',
    'met, with "finalText" as the spoken summary. A "done" on the very first step means the',
    "task needs no on-screen action - just advise the user in finalText.",
  ].join("\n");
}

/** Builds a `data:` URI for a screenshot (the image travels as one URI string). */
function screenshotDataUri(screenshot: AgentScreenshot): string {
  return `data:${screenshot.mediaType};base64,${screenshot.base64Data}`;
}

/** Builds the first user turn: the spoken goal plus the first screenshot. */
export function initialUserMessage(goal: string, screenshot: AgentScreenshot): VisionChatMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: goal },
      { type: "image_url", image_url: { url: screenshotDataUri(screenshot) } },
    ],
  };
}

/** Builds the follow-up user turn: the screen resulting from the previous Action. */
export function followUpUserMessage(screenshot: AgentScreenshot): VisionChatMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "Here is the screen after that action. Decide the next step." },
      { type: "image_url", image_url: { url: screenshotDataUri(screenshot) } },
    ],
  };
}

/**
 * Drops the screenshot (image parts) from every prior user turn, keeping their text, so
 * only the latest Step's screenshot is ever sent - bounding token cost across a long
 * Session. Assistant turns (the model's action objects) are left untouched.
 */
export function stripPriorScreenshots(messages: VisionChatMessage[]): VisionChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }
    const textParts = message.content.filter((part): part is { type: "text"; text: string } => part.type === "text");
    return { role: "user", content: textParts };
  });
}

/** Builds the outbound non-streaming chat request from the accumulated conversation. */
export function buildVisionAgentRequest(options: {
  messages: VisionChatMessage[];
  model: string;
  display: AgentDisplay;
  tokenLimitField: TokenLimitField;
}): VisionAgentChatRequest {
  const { messages, model, display, tokenLimitField } = options;
  return {
    model,
    messages: [{ role: "system", content: buildVisionAgentSystemPrompt(display) }, ...messages],
    response_format: { type: "json_object" },
    [tokenLimitField]: AGENT_STEP_MAX_TOKENS,
  };
}

/** The result of parsing one chat completion: the canonical Action and the raw reply text. */
export interface VisionAgentStep {
  action: AgentAction;
  /** The model's raw reply, appended verbatim as the assistant turn for continuity. */
  assistantContent: string;
}

/**
 * Parses one raw chat completion into a canonical Action plus the assistant text to append
 * for continuity. Reads `choices[0].message.content`, extracts the JSON object from it
 * (tolerating fences / surrounding prose), and translates it. Any failure to read or parse
 * degrades to a no-op `observe` - fail-safe, never a mystery OS action.
 */
export function parseVisionAgentResponse(rawJson: string): VisionAgentStep {
  const content = readCompletionContent(rawJson);
  return { action: parseVisionAgentAction(content), assistantContent: content };
}

/** Reads the assistant message text out of an OpenAI-compatible chat completion body. */
function readCompletionContent(rawJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return "";
  }
  const choices = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
  const message = firstChoice !== undefined && isRecord(firstChoice.message) ? firstChoice.message : undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  // Some Vendors return content as an array of parts; concatenate their text.
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/**
 * Translates the model's JSON action object (as raw reply text) into a canonical Action.
 * The `consequence` field is the model's own risk tag, folded through the escalate-only
 * combinator so the Capability's floor plugs in on top. Malformed JSON, a missing/unknown
 * `action`, or an off-shape object all degrade to a no-op `observe`.
 */
export function parseVisionAgentAction(replyText: string): AgentAction {
  const object = extractJsonObject(replyText);
  if (object === null) {
    return { kind: "observe", consequence: "benign" };
  }

  const consequence: ConsequenceLevel = escalateConsequence(readConsequenceArg(object.consequence), "benign");
  const action = readStringArg(object.action);

  switch (action) {
    case "click":
      return { kind: "click", x: readNumberArg(object.x), y: readNumberArg(object.y), consequence };
    case "type":
      return { kind: "type", text: readStringArg(object.text), ...typeTargetFields(object), consequence };
    case "key":
      return { kind: "key", combo: readKeyComboArg(object.combo), consequence };
    case "scroll":
      return {
        kind: "scroll",
        x: readNumberArg(object.x),
        y: readNumberArg(object.y),
        direction: readScrollDirectionArg(object.direction),
        amount: readNumberArg(object.amount),
        consequence,
      };
    case "copy":
      return { kind: "copy", text: readStringArg(object.text), consequence };
    case "done":
      return { kind: "done", finalText: readStringArg(object.finalText) };
    case "observe":
      return { kind: "observe", consequence };
    default:
      // A missing/unknown action is fail-safe: look again, never perform an unmapped OS action.
      return { kind: "observe", consequence };
  }
}

/**
 * Reads the optional compound-type targeting fields: a click-before-type coordinate (only
 * when both x and y are given as numbers) and a press-Return-after flag. Absent fields are
 * omitted so a bare `type` stays a plain type-at-focus.
 */
function typeTargetFields(object: Record<string, unknown>): { x?: number; y?: number; pressEnter?: boolean } {
  const fields: { x?: number; y?: number; pressEnter?: boolean } = {};
  if (typeof object.x === "number" && Number.isFinite(object.x) && typeof object.y === "number" && Number.isFinite(object.y)) {
    fields.x = object.x;
    fields.y = object.y;
  }
  if (object.pressEnter === true) {
    fields.pressEnter = true;
  }
  return fields;
}

/** Reads the model's consequence tag, defaulting to `benign` on anything but "consequential". */
function readConsequenceArg(value: unknown): ConsequenceLevel {
  return value === "consequential" ? "consequential" : "benign";
}

/**
 * Extracts the JSON action object from the model's reply, tolerating a bare object, a
 * ```json fenced block, or an object embedded in surrounding prose (by taking the span from
 * the first `{` to the last `}`). Returns `null` when nothing parses to an object.
 */
function extractJsonObject(replyText: string): Record<string, unknown> | null {
  const trimmed = replyText.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const candidates: string[] = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Whether a value is a non-null object we can index by string key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The vision-driven adapter's own conversation state, persisted between Steps. */
interface VisionAdapterState {
  /** The full chat conversation so far (user turns + the model's assistant action turns). */
  messages: VisionChatMessage[];
}

/**
 * The vision-driven agent adapter (M2-07): composes the pure translation above with the
 * injected `upstreamFetch` to advance the Session one Step on the Vendor's ordinary vision
 * chat model. It starts a new conversation from the goal on the first Step, and on later
 * Steps strips prior screenshots and feeds the fresh one back as a follow-up user turn.
 */
export function createVisionDrivenAgentAdapter(config: VisionDrivenVendorConfig): ComputerUseVendorAdapter {
  return {
    vendorId: config.vendorId,
    // The whole point of this path: acting runs on the config's advisory chat Model Slot,
    // not a dedicated computer-use model.
    usesAdvisoryModelSlot: true,
    async step(input: ComputerUseStepInput): Promise<ComputerUseStepResult> {
      const priorState = input.priorState as VisionAdapterState | undefined;

      const messages: VisionChatMessage[] =
        priorState === undefined
          ? [initialUserMessage(input.goal ?? "", input.screenshot)]
          : [...stripPriorScreenshots(priorState.messages), followUpUserMessage(input.screenshot)];

      const request = buildVisionAgentRequest({
        messages,
        model: input.model,
        display: input.display,
        tokenLimitField: config.tokenLimitField,
      });

      const response = await input.upstreamFetch(config.chatCompletionsUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });

      await throwIfStepResponseNotOk(response, config.displayName);

      const parsed = parseVisionAgentResponse(await response.text());
      if (parsed.action.kind === "done") {
        return { action: parsed.action, nextState: undefined };
      }

      const advancedMessages: VisionChatMessage[] = [
        ...messages,
        { role: "assistant", content: parsed.assistantContent },
      ];
      return {
        action: parsed.action,
        nextState: { messages: advancedMessages } satisfies VisionAdapterState,
      };
    },
  };
}
