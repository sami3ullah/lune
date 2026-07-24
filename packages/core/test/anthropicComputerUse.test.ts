import { describe, expect, it } from "vitest";

import { escalateConsequence } from "../src/agent/agentAction";
import {
  buildAnthropicComputerUseRequest,
  initialUserMessage,
  parseAnthropicComputerUseResponse,
  toolResultMessage,
} from "../src/agent/anthropicComputerUse";

/**
 * Pure-unit tests for the Anthropic computer-use adapter and the escalate-only
 * Consequence combinator - the two pieces the testing plan calls out as pure
 * functions: the per-Vendor computer-use-response -> canonical Action translation, and
 * `max(model tag, floor)`. Carried from v1's Sidecar suite.
 */

/** Builds a raw Anthropic Messages response JSON with a single computer tool_use. */
function toolUseResponse(action: Record<string, unknown>): string {
  return JSON.stringify({
    content: [{ type: "tool_use", id: "toolu_x", name: "computer", input: action }],
    stop_reason: "tool_use",
  });
}

describe("parseAnthropicComputerUseResponse - Action kind translation", () => {
  it("translates a left_click into a click Action at the coordinate", () => {
    const step = parseAnthropicComputerUseResponse(toolUseResponse({ action: "left_click", coordinate: [12, 34] }));
    expect(step.action).toEqual({ kind: "click", x: 12, y: 34, consequence: "benign" });
    expect(step.pendingToolUseId).toBe("toolu_x");
  });

  it("treats every click variant as a click", () => {
    for (const clickAction of ["right_click", "middle_click", "double_click", "triple_click", "mouse_click"]) {
      const step = parseAnthropicComputerUseResponse(toolUseResponse({ action: clickAction, coordinate: [5, 6] }));
      expect(step.action).toMatchObject({ kind: "click", x: 5, y: 6 });
    }
  });

  it("translates a type into a type Action carrying the text", () => {
    const step = parseAnthropicComputerUseResponse(toolUseResponse({ action: "type", text: "hello world" }));
    expect(step.action).toEqual({ kind: "type", text: "hello world", consequence: "benign" });
  });

  it("translates a key into a key Action carrying the combo", () => {
    const step = parseAnthropicComputerUseResponse(toolUseResponse({ action: "key", text: "cmd+s" }));
    expect(step.action).toEqual({ kind: "key", combo: "cmd+s", consequence: "benign" });
  });

  it("translates a scroll into a scroll Action with coordinate, direction, and amount", () => {
    const step = parseAnthropicComputerUseResponse(
      toolUseResponse({ action: "scroll", coordinate: [100, 200], scroll_direction: "down", scroll_amount: 3 }),
    );
    expect(step.action).toEqual({
      kind: "scroll",
      x: 100,
      y: 200,
      direction: "down",
      amount: 3,
      consequence: "benign",
    });
  });

  it("maps a bare screenshot/wait/unknown action to a no-op observe (fail-safe)", () => {
    for (const passiveAction of ["screenshot", "wait", "cursor_position", "mouse_move", "some_future_action"]) {
      const step = parseAnthropicComputerUseResponse(toolUseResponse({ action: passiveAction }));
      expect(step.action).toEqual({ kind: "observe", consequence: "benign" });
    }
  });

  it("defaults a malformed coordinate to the origin rather than throwing", () => {
    const step = parseAnthropicComputerUseResponse(toolUseResponse({ action: "left_click" }));
    expect(step.action).toMatchObject({ kind: "click", x: 0, y: 0 });
  });

  it("returns a done Action with the concatenated text when there is no tool_use", () => {
    const rawResponse = JSON.stringify({
      content: [
        { type: "text", text: "I filled it in. " },
        { type: "text", text: "All done." },
      ],
      stop_reason: "end_turn",
    });
    const step = parseAnthropicComputerUseResponse(rawResponse);
    expect(step.action).toEqual({ kind: "done", finalText: "I filled it in. All done." });
    expect(step.pendingToolUseId).toBeUndefined();
  });

  it("preserves the assistant content for conversation continuity", () => {
    const step = parseAnthropicComputerUseResponse(
      toolUseResponse({ action: "left_click", coordinate: [1, 1] }),
    );
    expect(step.assistantContent).toEqual([
      { type: "tool_use", id: "toolu_x", name: "computer", input: { action: "left_click", coordinate: [1, 1] } },
    ]);
  });
});

describe("Anthropic request construction", () => {
  it("builds the first user turn from the goal and screenshot", () => {
    const message = initialUserMessage("do the thing", { base64Data: "IMG", mediaType: "image/png" });
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "do the thing" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG" } },
      ],
    });
  });

  it("feeds a follow-up screenshot back as a tool_result referencing the pending tool_use", () => {
    const message = toolResultMessage("toolu_7", { base64Data: "IMG2", mediaType: "image/jpeg" });
    expect(message).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_7",
          content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "IMG2" } }],
        },
      ],
    });
  });

  it("sizes the computer tool to the display and sets the model + system prompt", () => {
    const request = buildAnthropicComputerUseRequest({
      messages: [initialUserMessage("x", { base64Data: "IMG", mediaType: "image/png" })],
      model: "claude-sonnet-4-6",
      display: { width: 1280, height: 800 },
      systemPrompt: "you are lune",
    });
    expect(request.model).toBe("claude-sonnet-4-6");
    expect(request.system).toBe("you are lune");
    expect(request.tools[0]).toMatchObject({
      type: "computer_20250124",
      name: "computer",
      display_width_px: 1280,
      display_height_px: 800,
    });
  });
});

describe("escalateConsequence - escalate-only floor combinator", () => {
  it("stays benign only when both the model tag and the floor are benign", () => {
    expect(escalateConsequence("benign", "benign")).toBe("benign");
  });

  it("escalates when the model tags consequential even if the floor is benign", () => {
    expect(escalateConsequence("consequential", "benign")).toBe("consequential");
  });

  it("escalates when the floor is consequential even if the model tagged benign (cannot downgrade)", () => {
    expect(escalateConsequence("benign", "consequential")).toBe("consequential");
  });

  it("stays consequential when both agree", () => {
    expect(escalateConsequence("consequential", "consequential")).toBe("consequential");
  });
});
