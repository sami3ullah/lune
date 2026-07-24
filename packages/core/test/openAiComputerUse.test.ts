import { describe, expect, it } from "vitest";

import {
  buildOpenAiComputerUseRequest,
  computerCallOutputItem,
  initialUserItem,
  OPENAI_COMPUTER_TOOL_TYPE,
  parseOpenAiComputerUseResponse,
} from "../src/agent/openAiComputerUse";

/**
 * Pure-unit tests for the OpenAI computer-use adapter - the two pieces the ticket calls
 * out: the per-Vendor computer-use-response -> canonical Action translation (each Action
 * kind), and request construction / session-continuity helpers. The HTTP call, session
 * storage, and gating live in the Screen Agent Capability above and are covered at that
 * seam in `agentStep.test.ts`. Mirrors `anthropicComputerUse.test.ts` /
 * `geminiComputerUse.test.ts` for the third acting Vendor.
 */

/** Builds a raw OpenAI Responses response JSON with a single computer_call output item. */
function computerCallResponse(
  action: Record<string, unknown>,
  options?: { callId?: string; safetyChecks?: Array<Record<string, unknown>> },
): string {
  return JSON.stringify({
    id: "resp_1",
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "computer_call",
        id: "cu_1",
        call_id: options?.callId ?? "call_1",
        action,
        status: "completed",
        pending_safety_checks: options?.safetyChecks ?? [],
      },
    ],
  });
}

describe("parseOpenAiComputerUseResponse - Action kind translation", () => {
  it("translates a click into a click Action at the coordinate", () => {
    const step = parseOpenAiComputerUseResponse(computerCallResponse({ type: "click", button: "left", x: 12, y: 34 }));
    expect(step.action).toEqual({ kind: "click", x: 12, y: 34, consequence: "benign" });
    expect(step.pendingCallId).toBe("call_1");
  });

  it("treats every mouse button and a double_click as a click at the coordinate", () => {
    for (const clickAction of [
      { type: "click", button: "right", x: 5, y: 6 },
      { type: "click", button: "wheel", x: 5, y: 6 },
      { type: "click", button: "back", x: 5, y: 6 },
      { type: "click", button: "forward", x: 5, y: 6 },
      { type: "double_click", x: 5, y: 6 },
    ]) {
      const step = parseOpenAiComputerUseResponse(computerCallResponse(clickAction));
      expect(step.action).toMatchObject({ kind: "click", x: 5, y: 6 });
    }
  });

  it("translates a type into a type Action carrying the text", () => {
    const step = parseOpenAiComputerUseResponse(computerCallResponse({ type: "type", text: "hello world" }));
    expect(step.action).toEqual({ kind: "type", text: "hello world", consequence: "benign" });
  });

  it("translates a keypress into a key Action joining the keys with +", () => {
    const step = parseOpenAiComputerUseResponse(computerCallResponse({ type: "keypress", keys: ["cmd", "s"] }));
    expect(step.action).toEqual({ kind: "key", combo: "cmd+s", consequence: "benign" });
  });

  it("translates a single-key keypress into a key Action", () => {
    const step = parseOpenAiComputerUseResponse(computerCallResponse({ type: "keypress", keys: ["ENTER"] }));
    expect(step.action).toEqual({ kind: "key", combo: "ENTER", consequence: "benign" });
  });

  it("translates a scroll into a scroll Action, deriving direction and amount from the deltas", () => {
    const down = parseOpenAiComputerUseResponse(
      computerCallResponse({ type: "scroll", x: 100, y: 200, scroll_x: 0, scroll_y: 120 }),
    );
    expect(down.action).toEqual({
      kind: "scroll",
      x: 100,
      y: 200,
      direction: "down",
      amount: 120,
      consequence: "benign",
    });

    const up = parseOpenAiComputerUseResponse(
      computerCallResponse({ type: "scroll", x: 1, y: 2, scroll_x: 0, scroll_y: -80 }),
    );
    expect(up.action).toMatchObject({ kind: "scroll", direction: "up", amount: 80 });

    const right = parseOpenAiComputerUseResponse(
      computerCallResponse({ type: "scroll", x: 1, y: 2, scroll_x: 45, scroll_y: 0 }),
    );
    expect(right.action).toMatchObject({ kind: "scroll", direction: "right", amount: 45 });

    const left = parseOpenAiComputerUseResponse(
      computerCallResponse({ type: "scroll", x: 1, y: 2, scroll_x: -45, scroll_y: 0 }),
    );
    expect(left.action).toMatchObject({ kind: "scroll", direction: "left", amount: 45 });
  });

  it("maps wait/screenshot/move/drag/unknown to a no-op observe (fail-safe)", () => {
    for (const passiveAction of [
      { type: "wait" },
      { type: "screenshot" },
      { type: "move", x: 1, y: 2 },
      { type: "drag", path: [{ x: 1, y: 2 }] },
      { type: "some_future_action" },
    ]) {
      const step = parseOpenAiComputerUseResponse(computerCallResponse(passiveAction));
      expect(step.action).toEqual({ kind: "observe", consequence: "benign" });
    }
  });

  it("defaults a malformed coordinate to the origin rather than throwing", () => {
    const step = parseOpenAiComputerUseResponse(computerCallResponse({ type: "click", button: "left" }));
    expect(step.action).toMatchObject({ kind: "click", x: 0, y: 0 });
  });

  it("escalates the model tag to consequential when the computer_call carries pending safety checks", () => {
    const step = parseOpenAiComputerUseResponse(
      computerCallResponse(
        { type: "click", button: "left", x: 1, y: 1 },
        { safetyChecks: [{ id: "cs_1", code: "malicious_instructions", message: "risky" }] },
      ),
    );
    expect(step.action.kind === "click" && step.action.consequence).toBe("consequential");
    expect(step.pendingSafetyChecks).toEqual([{ id: "cs_1", code: "malicious_instructions", message: "risky" }]);
  });

  it("returns a done Action with the concatenated output text when there is no computer_call", () => {
    const rawResponse = JSON.stringify({
      id: "resp_2",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "I filled it in. " },
            { type: "output_text", text: "All done." },
          ],
        },
      ],
    });
    const step = parseOpenAiComputerUseResponse(rawResponse);
    expect(step.action).toEqual({ kind: "done", finalText: "I filled it in. All done." });
    expect(step.pendingCallId).toBeUndefined();
  });

  it("preserves the raw output items for conversation continuity", () => {
    const step = parseOpenAiComputerUseResponse(computerCallResponse({ type: "click", button: "left", x: 1, y: 1 }));
    expect(step.outputItems).toEqual([
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "computer_call",
        id: "cu_1",
        call_id: "call_1",
        action: { type: "click", button: "left", x: 1, y: 1 },
        status: "completed",
        pending_safety_checks: [],
      },
    ]);
  });
});

describe("OpenAI request construction and continuity helpers", () => {
  it("builds the first user turn from the goal and screenshot as a data URI", () => {
    const item = initialUserItem("do the thing", { base64Data: "IMG", mediaType: "image/png" });
    expect(item).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "do the thing" },
        { type: "input_image", image_url: "data:image/png;base64,IMG" },
      ],
    });
  });

  it("feeds a follow-up screenshot back as a computer_call_output referencing the pending call", () => {
    const item = computerCallOutputItem("call_7", { base64Data: "IMG2", mediaType: "image/jpeg" }, []);
    expect(item).toEqual({
      type: "computer_call_output",
      call_id: "call_7",
      output: { type: "computer_screenshot", image_url: "data:image/jpeg;base64,IMG2" },
    });
  });

  it("acknowledges pending safety checks on the follow-up output when there were any", () => {
    const safetyChecks = [{ id: "cs_1", code: "malicious_instructions", message: "risky" }];
    const item = computerCallOutputItem("call_7", { base64Data: "IMG2", mediaType: "image/png" }, safetyChecks);
    expect(item.acknowledged_safety_checks).toEqual(safetyChecks);
  });

  it("sizes the computer tool to the display and sets the model, instructions, and truncation", () => {
    const request = buildOpenAiComputerUseRequest({
      input: [initialUserItem("x", { base64Data: "IMG", mediaType: "image/png" })],
      model: "computer-use-preview",
      display: { width: 1280, height: 800 },
      systemPrompt: "you are lune",
    });
    expect(request.model).toBe("computer-use-preview");
    expect(request.instructions).toBe("you are lune");
    expect(request.truncation).toBe("auto");
    expect(request.tools[0]).toMatchObject({
      type: OPENAI_COMPUTER_TOOL_TYPE,
      display_width: 1280,
      display_height: 800,
    });
  });
});
