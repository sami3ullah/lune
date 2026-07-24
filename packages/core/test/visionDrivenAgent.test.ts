import { describe, expect, it } from "vitest";

import {
  buildVisionAgentRequest,
  buildVisionAgentSystemPrompt,
  followUpUserMessage,
  initialUserMessage,
  parseVisionAgentAction,
  parseVisionAgentResponse,
  stripPriorScreenshots,
  type VisionChatMessage,
} from "../src/agent/visionDrivenAgent";

/**
 * Pure-unit tests for the vision-driven agent adapter (M2-07) - the two pieces the ticket
 * calls out: the JSON-action -> canonical Action translation (each Action kind, plus
 * malformed -> observe), and request construction / session-continuity helpers (system
 * prompt, screenshot trimming). The HTTP call, session storage, and gating live in the
 * Screen Agent Capability above and are covered at that seam in `visionDrivenAgentStep.test.ts`.
 */

/** Wraps a raw model reply string in an OpenAI-compatible chat completion body. */
function chatCompletion(content: string): string {
  return JSON.stringify({
    id: "chatcmpl_1",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

/** The model's JSON action reply as a completion body. */
function actionCompletion(action: Record<string, unknown>): string {
  return chatCompletion(JSON.stringify(action));
}

describe("parseVisionAgentAction - Action kind translation", () => {
  it("translates a click into a click Action at the coordinate", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "click", x: 12, y: 34, consequence: "benign" }))).toEqual({
      kind: "click",
      x: 12,
      y: 34,
      consequence: "benign",
    });
  });

  it("translates a bare type into a type-at-focus Action carrying the text", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "type", text: "hello world", consequence: "benign" }))).toEqual({
      kind: "type",
      text: "hello world",
      consequence: "benign",
    });
  });

  it("translates a compound type with a target point and press-enter", () => {
    const action = parseVisionAgentAction(
      JSON.stringify({ action: "type", text: "search this", x: 100, y: 200, pressEnter: true, consequence: "benign" }),
    );
    expect(action).toEqual({ kind: "type", text: "search this", x: 100, y: 200, pressEnter: true, consequence: "benign" });
  });

  it("omits the type target point unless both x and y are numbers", () => {
    const action = parseVisionAgentAction(JSON.stringify({ action: "type", text: "hi", x: 100, consequence: "benign" }));
    expect(action).toEqual({ kind: "type", text: "hi", consequence: "benign" });
  });

  it("translates a key into a key Action carrying the combo", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "key", combo: "cmd+s", consequence: "benign" }))).toEqual({
      kind: "key",
      combo: "cmd+s",
      consequence: "benign",
    });
  });

  it("joins an array combo with + (tolerating the model expressing keys as a list)", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "key", combo: ["cmd", "shift", "4"], consequence: "benign" }))).toEqual({
      kind: "key",
      combo: "cmd+shift+4",
      consequence: "benign",
    });
  });

  it("translates a scroll into a scroll Action with direction and amount", () => {
    expect(
      parseVisionAgentAction(JSON.stringify({ action: "scroll", x: 5, y: 6, direction: "down", amount: 120, consequence: "benign" })),
    ).toEqual({ kind: "scroll", x: 5, y: 6, direction: "down", amount: 120, consequence: "benign" });
  });

  it("defaults a scroll's direction to down on a garbage value rather than throwing", () => {
    const action = parseVisionAgentAction(JSON.stringify({ action: "scroll", x: 5, y: 6, direction: "sideways", consequence: "benign" }));
    expect(action).toMatchObject({ kind: "scroll", direction: "down", amount: 0 });
  });

  it("translates a copy into a copy Action carrying the clipboard text", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "copy", text: "clip me", consequence: "benign" }))).toEqual({
      kind: "copy",
      text: "clip me",
      consequence: "benign",
    });
  });

  it("translates an observe into a no-op observe Action", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "observe", consequence: "benign" }))).toEqual({
      kind: "observe",
      consequence: "benign",
    });
  });

  it("translates a done into the terminal done Action carrying the spoken summary", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "done", finalText: "All finished." }))).toEqual({
      kind: "done",
      finalText: "All finished.",
    });
  });

  it("folds the model's consequential tag through so a send/delete/pay is flagged", () => {
    const action = parseVisionAgentAction(JSON.stringify({ action: "click", x: 1, y: 1, consequence: "consequential" }));
    expect(action).toEqual({ kind: "click", x: 1, y: 1, consequence: "consequential" });
  });

  it("treats an absent or unknown consequence tag as benign (the floor still runs above)", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "click", x: 1, y: 1 }))).toMatchObject({ consequence: "benign" });
    expect(parseVisionAgentAction(JSON.stringify({ action: "click", x: 1, y: 1, consequence: "spicy" }))).toMatchObject({
      consequence: "benign",
    });
  });

  it("defaults a malformed coordinate to the origin rather than throwing", () => {
    expect(parseVisionAgentAction(JSON.stringify({ action: "click", consequence: "benign" }))).toMatchObject({
      kind: "click",
      x: 0,
      y: 0,
    });
  });

  it("degrades a missing or unknown action to a no-op observe (fail-safe)", () => {
    for (const reply of [
      JSON.stringify({ consequence: "benign" }),
      JSON.stringify({ action: "self_destruct", consequence: "benign" }),
    ]) {
      expect(parseVisionAgentAction(reply)).toEqual({ kind: "observe", consequence: "benign" });
    }
  });

  it("degrades non-JSON / non-object replies to observe rather than throwing", () => {
    for (const reply of ["not json at all", "", "42", "[1, 2, 3]"]) {
      expect(parseVisionAgentAction(reply)).toEqual({ kind: "observe", consequence: "benign" });
    }
  });

  it("tolerates a JSON object wrapped in a markdown code fence or prose", () => {
    const fenced = '```json\n{ "action": "click", "x": 7, "y": 8, "consequence": "benign" }\n```';
    expect(parseVisionAgentAction(fenced)).toEqual({ kind: "click", x: 7, y: 8, consequence: "benign" });

    const prose = 'Sure, I will click there: { "action": "click", "x": 7, "y": 8, "consequence": "benign" }';
    expect(parseVisionAgentAction(prose)).toEqual({ kind: "click", x: 7, y: 8, consequence: "benign" });
  });
});

describe("parseVisionAgentResponse - reading the chat completion", () => {
  it("reads the assistant message content and translates it, keeping the raw reply for continuity", () => {
    const raw = actionCompletion({ action: "click", x: 3, y: 4, consequence: "benign" });
    const step = parseVisionAgentResponse(raw);
    expect(step.action).toEqual({ kind: "click", x: 3, y: 4, consequence: "benign" });
    expect(step.assistantContent).toBe(JSON.stringify({ action: "click", x: 3, y: 4, consequence: "benign" }));
  });

  it("concatenates array-shaped content parts before parsing", () => {
    const raw = JSON.stringify({
      choices: [{ message: { role: "assistant", content: [{ type: "text", text: '{ "action": ' }, { type: "text", text: '"observe", "consequence": "benign" }' }] } }],
    });
    expect(parseVisionAgentResponse(raw).action).toEqual({ kind: "observe", consequence: "benign" });
  });

  it("degrades a body with no choices to observe", () => {
    expect(parseVisionAgentResponse(JSON.stringify({ id: "x", choices: [] })).action).toEqual({
      kind: "observe",
      consequence: "benign",
    });
  });
});

describe("vision request construction and continuity helpers", () => {
  it("builds the first user turn from the goal and screenshot as a data URI", () => {
    expect(initialUserMessage("do the thing", { base64Data: "IMG", mediaType: "image/png" })).toEqual({
      role: "user",
      content: [
        { type: "text", text: "do the thing" },
        { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
      ],
    });
  });

  it("builds a follow-up turn carrying the fresh screenshot", () => {
    const message = followUpUserMessage({ base64Data: "IMG2", mediaType: "image/jpeg" });
    expect(message.role).toBe("user");
    const parts = message.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((part) => part.type === "image_url" && part.image_url?.url === "data:image/jpeg;base64,IMG2")).toBe(true);
  });

  it("states the display dimensions and the JSON grammar in the system prompt", () => {
    const prompt = buildVisionAgentSystemPrompt({ width: 1440, height: 900 });
    expect(prompt).toContain("1440x900 pixels");
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"consequence"');
    // The shared acting persona is included (extends AGENT_SYSTEM_PROMPT).
    expect(prompt).toContain("Lune");
  });

  it("prepends the system persona and carries the token limit under the Vendor's field", () => {
    const request = buildVisionAgentRequest({
      messages: [initialUserMessage("x", { base64Data: "IMG", mediaType: "image/png" })],
      model: "gpt-4o",
      display: { width: 1280, height: 800 },
      tokenLimitField: "max_completion_tokens",
    });
    expect(request.model).toBe("gpt-4o");
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[1].role).toBe("user");
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(request.max_completion_tokens).toBeGreaterThan(0);
    expect(request.max_tokens).toBeUndefined();
  });

  it("uses Gemini's max_tokens field when that is the Vendor's limit field", () => {
    const request = buildVisionAgentRequest({
      messages: [],
      model: "gemini-3.5-flash-lite",
      display: { width: 800, height: 600 },
      tokenLimitField: "max_tokens",
    });
    expect(request.max_tokens).toBeGreaterThan(0);
    expect(request.max_completion_tokens).toBeUndefined();
  });

  it("strips the screenshot from prior user turns, keeping only the latest and all assistant turns", () => {
    const history: VisionChatMessage[] = [
      initialUserMessage("goal", { base64Data: "IMG0", mediaType: "image/png" }),
      { role: "assistant", content: '{ "action": "click", "x": 1, "y": 1, "consequence": "benign" }' },
    ];
    const stripped = stripPriorScreenshots(history);

    // The prior user turn keeps its text but loses the image.
    const userParts = stripped[0].content as Array<{ type: string }>;
    expect(userParts.every((part) => part.type === "text")).toBe(true);
    expect(userParts.some((part) => part.type === "text")).toBe(true);
    // The assistant turn is untouched.
    expect(stripped[1]).toEqual(history[1]);
  });
});
