/**
 * The OpenAI computer-use adapter (DECISIONS #14-15): the third acting Vendor, behind
 * the same `ComputerUseVendorAdapter` seam as Anthropic and Gemini. v1 had OpenAI
 * advisory-only; this is new Lune work.
 *
 * Everything here is pure over its inputs (no network, no clock, no session storage),
 * so the two things that actually need proving - building the outbound OpenAI request
 * and parsing an OpenAI response into a canonical Action - are unit-testable in
 * isolation. The HTTP call, session storage, and gating live in the Screen Agent
 * Capability above this.
 *
 * OpenAI's computer use runs over the *Responses* API (`POST /v1/responses`) with the
 * `computer_use_preview` tool, a distinct protocol from OpenAI's chat-completions path
 * (`reasoning/cloudReasoningVendors.ts`):
 *   - the conversation is a flat `input` array of items, not chat messages; the request
 *     accumulates the whole array each Step (mirroring the other adapters, so continuity
 *     is self-contained and does not depend on server-side `previous_response_id` state);
 *   - the model replies with an `output` array; a `computer_call` item names the action
 *     (`click`/`type`/`keypress`/`scroll`/`wait`/`screenshot`/...) and carries a
 *     `call_id`; when it stops requesting the tool and just returns a `message`, the goal
 *     is done and the message text is the spoken summary;
 *   - the follow-up screenshot is fed back as a `computer_call_output` referencing that
 *     `call_id` (not a `tool_result` / `functionResponse`), with the image as a
 *     `computer_screenshot` data URI; the model's own `output` items are echoed back
 *     verbatim for continuity (the Responses API requires the reasoning items back);
 *   - coordinates are already in display-pixel space (like Anthropic; no 0-1000
 *     normalisation), so no denormalisation is needed.
 *
 * Safety checks: a `computer_call` can carry `pending_safety_checks` - OpenAI's native
 * per-Action risk signal. Unlike Anthropic/Gemini (which emit no tag, so their model tag
 * is always `benign`), this adapter maps a non-empty check list to a `consequential`
 * model tag through the escalate-only combinator, so it trips Lune's Confirm Gate. The
 * checks are then acknowledged on the follow-up `computer_call_output` (by then the Shell
 * has executed the Action, meaning it passed the Gate) so the Responses API proceeds.
 */
import type { AgentAction, ConsequenceLevel, ScrollDirection } from "./agentAction.js";
import { escalateConsequence } from "./agentAction.js";
import { readKeyComboArg, readNumberArg, readStringArg } from "./agentArgReaders.js";
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

/** A content part of a user input turn (text or image). */
export type OpenAiInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

/** A user turn in the Responses `input` array (the initial goal + screenshot). */
export interface OpenAiUserItem {
  role: "user";
  content: OpenAiInputContent[];
}

/**
 * The screenshot resulting from the previous Action, fed back for its `computer_call`.
 * Any safety checks the model raised are acknowledged here (see the module header).
 */
export interface OpenAiComputerCallOutputItem {
  type: "computer_call_output";
  call_id: string;
  output: { type: "computer_screenshot"; image_url: string };
  acknowledged_safety_checks?: OpenAiSafetyCheck[];
}

/**
 * A model `output` item echoed back verbatim for conversation continuity. Its exact
 * shape is opaque - the adapter reads only the fields it needs and re-sends the rest
 * untouched (the Responses API requires the reasoning items to come back intact).
 */
export type OpenAiOutputItem = Record<string, unknown>;

/** One item in the Responses API `input` array this adapter constructs or echoes. */
export type OpenAiInputItem = OpenAiUserItem | OpenAiComputerCallOutputItem | OpenAiOutputItem;

/** One safety check OpenAI raised on a `computer_call` (echoed back to acknowledge it). */
export interface OpenAiSafetyCheck {
  id: string;
  code?: string;
  message?: string;
}

/** The outbound OpenAI Responses request for one Agent Step. */
export interface OpenAiComputerUseRequest {
  model: string;
  instructions: string;
  tools: Array<Record<string, unknown>>;
  input: OpenAiInputItem[];
  /** Required for the computer-use-preview model, which can exceed the context window. */
  truncation: "auto";
}

/**
 * The result of parsing one OpenAI response: the canonical Action to return to the
 * Shell, the raw `output` items to echo back for continuity, the `call_id` the next
 * Step's `computer_call_output` must reference (absent when done), and any pending
 * safety checks to acknowledge on that follow-up.
 */
export interface OpenAiComputerUseStep {
  action: AgentAction;
  outputItems: OpenAiOutputItem[];
  pendingCallId?: string;
  pendingSafetyChecks: OpenAiSafetyCheck[];
}

/** The Responses API computer-use tool type. */
export const OPENAI_COMPUTER_TOOL_TYPE = "computer_use_preview";
/** The Responses API endpoint the adapter POSTs each Step to. */
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
/**
 * The environment the model reasons the computer tool acts in. The Screen Agent drives
 * the user's real desktop GUI (not a browser), and macOS is Lune's shipping/onboarding
 * platform, so `"mac"` is the accurate default; per-OS selection (windows/ubuntu) is a
 * later refinement once the seam carries the Session's platform.
 */
const OPENAI_COMPUTER_ENVIRONMENT = "mac";

/** Builds the first user turn: the spoken goal plus the first screenshot. */
export function initialUserItem(goal: string, screenshot: AgentScreenshot): OpenAiUserItem {
  return {
    role: "user",
    content: [
      { type: "input_text", text: goal },
      { type: "input_image", image_url: screenshotDataUri(screenshot) },
    ],
  };
}

/**
 * Builds the follow-up input item: the screenshot resulting from the previous Action,
 * fed back as the `computer_call_output` for the pending `computer_call`, acknowledging
 * any safety checks that Action carried. This closes the observe->act->observe loop.
 */
export function computerCallOutputItem(
  pendingCallId: string,
  screenshot: AgentScreenshot,
  acknowledgedSafetyChecks: OpenAiSafetyCheck[],
): OpenAiComputerCallOutputItem {
  const item: OpenAiComputerCallOutputItem = {
    type: "computer_call_output",
    call_id: pendingCallId,
    output: { type: "computer_screenshot", image_url: screenshotDataUri(screenshot) },
  };
  if (acknowledgedSafetyChecks.length > 0) {
    item.acknowledged_safety_checks = acknowledgedSafetyChecks;
  }
  return item;
}

/** Builds the outbound OpenAI Responses request from the accumulated conversation. */
export function buildOpenAiComputerUseRequest(options: {
  input: OpenAiInputItem[];
  model: string;
  display: AgentDisplay;
  systemPrompt: string;
}): OpenAiComputerUseRequest {
  const { input, model, display, systemPrompt } = options;
  return {
    model,
    instructions: systemPrompt,
    tools: [
      {
        type: OPENAI_COMPUTER_TOOL_TYPE,
        display_width: display.width,
        display_height: display.height,
        environment: OPENAI_COMPUTER_ENVIRONMENT,
      },
    ],
    input,
    truncation: "auto",
  };
}

/**
 * Parses one raw OpenAI Responses response into a canonical Action plus the continuity
 * data. If the model emitted a `computer_call`, its `action` is translated into the
 * matching canonical Action; if it emitted only a message (no computer_call), the goal
 * is done and the message text becomes the spoken summary.
 */
export function parseOpenAiComputerUseResponse(rawJson: string): OpenAiComputerUseStep {
  const parsed = JSON.parse(rawJson) as { output?: unknown };
  const outputItems: OpenAiOutputItem[] = Array.isArray(parsed.output)
    ? (parsed.output as OpenAiOutputItem[])
    : [];

  const computerCall = outputItems.find((item) => item.type === "computer_call");

  if (computerCall === undefined) {
    // No computer_call: the model is done and its message text is the spoken summary.
    return {
      action: { kind: "done", finalText: concatenateOutputText(outputItems) },
      outputItems,
      pendingSafetyChecks: [],
    };
  }

  const pendingSafetyChecks = readSafetyChecks(computerCall.pending_safety_checks);
  const action = translateComputerCall(
    isRecord(computerCall.action) ? computerCall.action : {},
    pendingSafetyChecks.length > 0,
  );

  // Leave `pendingCallId` undefined (not "") on a malformed call so the adapter's
  // defensive fallback to the prior id is live rather than persisting an empty id.
  const callId = readStringArg(computerCall.call_id);
  return {
    action,
    outputItems,
    pendingCallId: callId.length > 0 ? callId : undefined,
    pendingSafetyChecks,
  };
}

/**
 * Translates one OpenAI `computer_call` action into a canonical Action. The Consequence
 * Level is resolved through the escalate-only combinator: the model tag is
 * `consequential` when OpenAI raised a safety check on this Action, `benign` otherwise;
 * the Capability applies the real floor on top.
 */
function translateComputerCall(action: Record<string, unknown>, hasSafetyCheck: boolean): AgentAction {
  const type = readStringArg(action.type);
  const consequence: ConsequenceLevel = escalateConsequence(
    hasSafetyCheck ? "consequential" : "benign",
    "benign",
  );

  switch (type) {
    case "click":
    case "double_click": {
      return { kind: "click", x: readNumberArg(action.x), y: readNumberArg(action.y), consequence };
    }
    case "type": {
      return { kind: "type", text: readStringArg(action.text), consequence };
    }
    case "keypress": {
      return { kind: "key", combo: readKeyComboArg(action.keys), consequence };
    }
    case "scroll": {
      const { direction, amount } = readScrollDeltas(action.scroll_x, action.scroll_y);
      return {
        kind: "scroll",
        x: readNumberArg(action.x),
        y: readNumberArg(action.y),
        direction,
        amount,
        consequence,
      };
    }
    default:
      // `wait`, `screenshot`, `move`, `drag`, and any action we do not (yet) execute all
      // resolve to a no-op observe: the Shell just captures the screen again and the loop
      // continues. Defaulting unknowns to observe is fail-safe - it never performs an OS
      // action we did not explicitly map.
      return { kind: "observe", consequence };
  }
}

/** The OpenAI adapter's own conversation state, persisted between Steps. */
interface OpenAiAdapterState {
  /** The full Responses `input` so far, including echoed model output items. */
  input: OpenAiInputItem[];
  /** The `call_id` the next Step's screenshot must be returned against. */
  pendingCallId: string;
  /** The safety checks to acknowledge on the next `computer_call_output`. */
  pendingSafetyChecks: OpenAiSafetyCheck[];
}

/**
 * The OpenAI computer-use adapter (DECISIONS #14-15): composes the pure translation
 * above with the injected `upstreamFetch` to advance the Session one Step. It starts a
 * new conversation from the goal on the first Step, and on later Steps feeds the fresh
 * screenshot back as the `computer_call_output` for the pending `computer_call`.
 */
export function createOpenAiComputerUseAdapter(): ComputerUseVendorAdapter {
  return {
    vendorId: "openai",
    // OpenAI's computer use is the dedicated computer-use-preview model, not the chat slot.
    usesAdvisoryModelSlot: false,
    async step(input: ComputerUseStepInput): Promise<ComputerUseStepResult> {
      const priorState = input.priorState as OpenAiAdapterState | undefined;

      const conversation: OpenAiInputItem[] =
        priorState === undefined
          ? [initialUserItem(input.goal ?? "", input.screenshot)]
          : [
              ...priorState.input,
              computerCallOutputItem(priorState.pendingCallId, input.screenshot, priorState.pendingSafetyChecks),
            ];

      const request = buildOpenAiComputerUseRequest({
        input: conversation,
        model: input.model,
        display: input.display,
        systemPrompt: AGENT_SYSTEM_PROMPT,
      });

      const response = await input.upstreamFetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });

      await throwIfStepResponseNotOk(response, "OpenAI");

      const parsed = parseOpenAiComputerUseResponse(await response.text());
      if (parsed.action.kind === "done") {
        return { action: parsed.action, nextState: undefined };
      }

      const advancedInput = [...conversation, ...parsed.outputItems];
      return {
        action: parsed.action,
        nextState: {
          input: advancedInput,
          // A non-done OpenAI step always came from a computer_call, so its call_id is
          // set; fall back defensively to the prior id rather than persisting an empty one.
          pendingCallId: parsed.pendingCallId ?? priorState?.pendingCallId ?? "",
          pendingSafetyChecks: parsed.pendingSafetyChecks,
        } satisfies OpenAiAdapterState,
      };
    },
  };
}

/** Builds a `data:` URI for a screenshot (OpenAI takes the image as one URI string). */
function screenshotDataUri(screenshot: AgentScreenshot): string {
  return `data:${screenshot.mediaType};base64,${screenshot.base64Data}`;
}

/** Concatenates the `output_text` of the response's message items into the spoken summary. */
function concatenateOutputText(items: OpenAiOutputItem[]): string {
  return items
    .filter((item) => item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? (item.content as unknown[]) : []))
    .filter(
      (part): part is { type: "output_text"; text: string } =>
        isRecord(part) && part.type === "output_text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * Derives a canonical scroll direction + amount from OpenAI's `scroll_x`/`scroll_y`
 * pixel deltas, taking the dominant axis. Amount is the magnitude in OpenAI's own unit;
 * the Shell maps it to scroll events. Defaults to a small downward scroll on garbage.
 */
function readScrollDeltas(rawX: unknown, rawY: unknown): { direction: ScrollDirection; amount: number } {
  const scrollX = readNumberArg(rawX);
  const scrollY = readNumberArg(rawY);
  if (Math.abs(scrollY) >= Math.abs(scrollX)) {
    if (scrollY === 0 && scrollX === 0) {
      return { direction: "down", amount: 0 };
    }
    return { direction: scrollY >= 0 ? "down" : "up", amount: Math.abs(scrollY) };
  }
  return { direction: scrollX >= 0 ? "right" : "left", amount: Math.abs(scrollX) };
}

/** Reads the `pending_safety_checks` array, keeping only well-formed entries. */
function readSafetyChecks(value: unknown): OpenAiSafetyCheck[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const checks: OpenAiSafetyCheck[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.id === "string") {
      checks.push({
        id: entry.id,
        ...(typeof entry.code === "string" ? { code: entry.code } : {}),
        ...(typeof entry.message === "string" ? { message: entry.message } : {}),
      });
    }
  }
  return checks;
}

/** Whether a value is a non-null object we can index by string key. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
