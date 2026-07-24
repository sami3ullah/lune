/**
 * The Google/Gemini computer-use adapter (DECISIONS #14-15): the second Screen Agent
 * Vendor, translating between Gemini's native computer-use surface and Lune's
 * vendor-independent canonical Action / conversation, exactly as
 * `anthropicComputerUse.ts` does for Anthropic.
 *
 * Gemini's surface differs from Anthropic's in three ways this module absorbs:
 *   - the call is `models/{model}:generateContent` with a `computerUse` tool, and the
 *     conversation is a list of `contents` (user/model turns of `parts`), not
 *     Anthropic messages;
 *   - the model replies with a `functionCall` part naming a predefined UI function
 *     (`click_at`, `type_text_at`, `key_combination`, `scroll_at`, ...) rather than a
 *     free-form tool_use, and the follow-up screenshot is fed back as a
 *     `functionResponse` (not a `tool_result`);
 *   - coordinates are normalised to a 0-1000 space, so this module denormalises them
 *     to the Session's display-pixel space (the space canonical Actions and the
 *     Shell's remap use).
 *
 * A couple of Gemini functions are compound (`type_text_at` clicks a point, types, and
 * can press Enter); the canonical `type` Action carries the optional target and
 * `pressEnter` so a compound stays one Action per Step. Browser-navigation and passive
 * functions (`open_web_page`, `wait_5_seconds`, `hover_at`, ...) map to a no-op
 * `observe` for this first wiring; richer navigation is a later refinement.
 *
 * NOTE: Gemini computer use is a preview API; the exact `functionResponse` wire shape
 * for returning a screenshot is the untested injected edge (like the other real
 * Runtime edges). The pure translation below - which the tests pin - is what this
 * module owns; the real HTTP call in the adapter is thin and untested.
 *
 * Carried from v1's Sidecar (`agent/geminiComputerUse.ts`), unchanged in behaviour.
 */
import type { AgentAction, ConsequenceLevel } from "./agentAction.js";
import { escalateConsequence } from "./agentAction.js";
import { readStringArg, readScrollDirectionArg } from "./agentArgReaders.js";
import { AGENT_SYSTEM_PROMPT } from "./agentSystemPrompt.js";
import {
  throwIfStepResponseNotOk,
  type AgentScreenshot,
  type ComputerUseStepInput,
  type ComputerUseStepResult,
  type ComputerUseVendorAdapter,
} from "./computerUseAdapter.js";

/** A Gemini content part (only the kinds this adapter produces/reads). */
export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

/** One turn of the accumulating Gemini conversation. */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** The outbound Gemini `generateContent` request for one Agent Step. */
export interface GeminiComputerUseRequest {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  tools: Array<Record<string, unknown>>;
}

/** The result of parsing one Gemini response: the canonical Action + continuity data. */
export interface GeminiComputerUseStep {
  action: AgentAction;
  /** The name of the function called (the next `functionResponse` references it); undefined when done. */
  functionName?: string;
  /** The model turn to append to the conversation for continuity. */
  modelContent: GeminiContent;
}

/** Gemini's coordinate space: normalised to 0-1000 on each axis. */
const GEMINI_COORDINATE_SPACE = 1000;
/** Default scroll magnitude when a scroll function omits one. */
const DEFAULT_SCROLL_AMOUNT = 3;

/** Builds the first user turn: the spoken goal plus the first screenshot. */
export function initialUserContent(goal: string, screenshot: AgentScreenshot): GeminiContent {
  return {
    role: "user",
    parts: [{ text: goal }, inlineDataPart(screenshot)],
  };
}

/**
 * Builds the follow-up user turn: the screenshot resulting from the previous Action,
 * fed back as the `functionResponse` for the function the model last called, with the
 * screenshot riding along as inline image data.
 */
export function functionResponseContent(
  pendingFunctionName: string,
  screenshot: AgentScreenshot,
): GeminiContent {
  return {
    role: "user",
    parts: [
      { functionResponse: { name: pendingFunctionName, response: {} } },
      inlineDataPart(screenshot),
    ],
  };
}

/** Builds the outbound Gemini request from the accumulated conversation. */
export function buildGeminiComputerUseRequest(options: {
  contents: GeminiContent[];
  systemPrompt: string;
}): GeminiComputerUseRequest {
  return {
    systemInstruction: { parts: [{ text: options.systemPrompt }] },
    contents: options.contents,
    // A Session is bound to one display; the browser environment is the only one
    // Gemini computer use supports today.
    tools: [{ computerUse: { environment: "ENVIRONMENT_BROWSER" } }],
  };
}

/**
 * Parses one raw Gemini response into a canonical Action plus the continuity data. If
 * the model called a computer-use function, it is translated (with coordinates
 * denormalised from 0-1000 to `display` pixels) into the matching canonical Action; if
 * it replied with only text, the goal is done and the text is the spoken summary.
 */
export function parseGeminiComputerUseResponse(
  rawJson: string,
  display: { width: number; height: number },
): GeminiComputerUseStep {
  const parsed = JSON.parse(rawJson) as {
    candidates?: Array<{ content?: GeminiContent }>;
  };
  const modelContent: GeminiContent = parsed.candidates?.[0]?.content ?? { role: "model", parts: [] };

  const functionCall = modelContent.parts.find(
    (part): part is Extract<GeminiPart, { functionCall: unknown }> => "functionCall" in part,
  );

  if (functionCall === undefined) {
    return {
      action: { kind: "done", finalText: concatenateText(modelContent.parts) },
      modelContent,
    };
  }

  return {
    action: translateFunctionCall(functionCall.functionCall.name, functionCall.functionCall.args, display),
    functionName: functionCall.functionCall.name,
    modelContent,
  };
}

/**
 * Translates one Gemini computer-use function call into a canonical Action, with
 * coordinates denormalised from Gemini's 0-1000 space to `display` pixels. The
 * Consequence Level is the model tag (benign) combined through the escalate-only
 * combinator; the Core floor escalates later.
 */
function translateFunctionCall(
  name: string,
  args: Record<string, unknown>,
  display: { width: number; height: number },
): AgentAction {
  const consequence: ConsequenceLevel = escalateConsequence("benign", "benign");

  switch (name) {
    case "click_at": {
      return {
        kind: "click",
        x: denormalizeCoordinate(args.x, display.width),
        y: denormalizeCoordinate(args.y, display.height),
        consequence,
      };
    }
    case "type_text_at": {
      return {
        kind: "type",
        text: readStringArg(args.text),
        x: denormalizeCoordinate(args.x, display.width),
        y: denormalizeCoordinate(args.y, display.height),
        pressEnter: args.press_enter === true,
        consequence,
      };
    }
    case "key_combination": {
      return { kind: "key", combo: readKeyCombination(args.keys), consequence };
    }
    case "scroll_at": {
      return {
        kind: "scroll",
        x: denormalizeCoordinate(args.x, display.width),
        y: denormalizeCoordinate(args.y, display.height),
        direction: readScrollDirectionArg(args.direction),
        amount: readAmount(args.magnitude),
        consequence,
      };
    }
    case "scroll_document": {
      // Scrolling the whole document has no coordinate; scroll at the display centre.
      return {
        kind: "scroll",
        x: Math.round(display.width / 2),
        y: Math.round(display.height / 2),
        direction: readScrollDirectionArg(args.direction),
        amount: DEFAULT_SCROLL_AMOUNT,
        consequence,
      };
    }
    default:
      // Browser navigation (open_web_page, go_back, search, ...) and passive functions
      // (wait_5_seconds, hover_at) and any function we do not yet execute resolve to a
      // no-op observe: the Shell just captures the screen again. Fail-safe - it never
      // performs an OS action we did not explicitly map.
      return { kind: "observe", consequence };
  }
}

/** The Gemini adapter's own conversation state, persisted between Steps. */
interface GeminiAdapterState {
  /** The full Gemini conversation so far, including model function-call turns. */
  contents: GeminiContent[];
  /** The name of the function the next `functionResponse` screenshot answers. */
  pendingFunctionName: string;
}

/**
 * The Gemini computer-use adapter: composes the pure translation above with the
 * injected `upstreamFetch` to advance the Session one Step. Starts a new conversation
 * from the goal on the first Step; on later Steps feeds the fresh screenshot back as
 * the `functionResponse` for the pending function.
 */
export function createGeminiComputerUseAdapter(): ComputerUseVendorAdapter {
  return {
    vendorId: "google",
    async step(input: ComputerUseStepInput): Promise<ComputerUseStepResult> {
      const priorState = input.priorState as GeminiAdapterState | undefined;

      const contents: GeminiContent[] =
        priorState === undefined
          ? [initialUserContent(input.goal ?? "", input.screenshot)]
          : [...priorState.contents, functionResponseContent(priorState.pendingFunctionName, input.screenshot)];

      const request = buildGeminiComputerUseRequest({ contents, systemPrompt: AGENT_SYSTEM_PROMPT });

      const response = await input.upstreamFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": input.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );

      await throwIfStepResponseNotOk(response, "Gemini");

      const parsed = parseGeminiComputerUseResponse(await response.text(), input.display);
      if (parsed.action.kind === "done") {
        return { action: parsed.action, nextState: undefined };
      }

      const advancedContents = [...contents, parsed.modelContent];
      return {
        action: parsed.action,
        nextState: {
          contents: advancedContents,
          pendingFunctionName: parsed.functionName ?? priorState?.pendingFunctionName ?? "",
        } satisfies GeminiAdapterState,
      };
    },
  };
}

/** A Gemini inline-image part for a screenshot. */
function inlineDataPart(screenshot: AgentScreenshot): GeminiPart {
  return { inlineData: { mimeType: screenshot.mediaType, data: screenshot.base64Data } };
}

/** Concatenates the text of a response's text parts into the spoken summary. */
function concatenateText(parts: GeminiPart[]): string {
  return parts
    .filter((part): part is Extract<GeminiPart, { text: string }> => "text" in part)
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * Denormalises a 0-1000 Gemini coordinate to a display pixel, clamped to the display.
 * A malformed value defaults to 0 rather than throwing.
 */
function denormalizeCoordinate(value: unknown, extent: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const pixel = Math.round((normalized / GEMINI_COORDINATE_SPACE) * extent);
  return Math.max(0, Math.min(extent, pixel));
}

/** Reads a scroll magnitude, defaulting to the standard amount when absent. */
function readAmount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SCROLL_AMOUNT;
}

/** Reads a key combination, accepting either a "ctrl+c" string or an array of keys. */
function readKeyCombination(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((key): key is string => typeof key === "string").join("+");
  }
  return "";
}
