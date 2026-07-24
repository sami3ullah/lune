import { describe, expect, it } from "vitest";

import {
  buildGeminiComputerUseRequest,
  functionResponseContent,
  initialUserContent,
  parseGeminiComputerUseResponse,
} from "../src/agent/geminiComputerUse";
import type { AgentDisplay } from "../src/agent/computerUseAdapter";

/**
 * Pure-unit tests for the Gemini computer-use translation (DECISIONS #14-15). Gemini's
 * native surface differs from Anthropic's - a `generateContent` call with a
 * `computerUse` tool, predefined UI functions returned as `functionCall` parts, and
 * coordinates normalised to a 0-1000 space - so the two things that must be proven are
 * the function -> canonical Action mapping and the 0-1000 -> display-pixel coordinate
 * denormalisation. The real HTTP call is the untested injected edge. Carried from v1.
 */

/** Builds a Gemini response whose model turn calls one computer-use function. */
function functionCallResponse(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }],
  });
}

/** An 800x600 display, so a 0-1000 coordinate denormalises to a different pixel value. */
const display800x600: AgentDisplay = { width: 800, height: 600 };

describe("parseGeminiComputerUseResponse - function -> canonical Action + denormalisation", () => {
  it("maps click_at and denormalises 0-1000 coordinates to display pixels", () => {
    // x 500/1000 * 800 = 400; y 500/1000 * 600 = 300.
    const step = parseGeminiComputerUseResponse(
      functionCallResponse("click_at", { x: 500, y: 500 }),
      display800x600,
    );
    expect(step.action).toEqual({ kind: "click", x: 400, y: 300, consequence: "benign" });
    expect(step.functionName).toBe("click_at");
  });

  it("maps type_text_at to a compound type with denormalised target and press-enter", () => {
    const step = parseGeminiComputerUseResponse(
      functionCallResponse("type_text_at", { x: 250, y: 500, text: "hello", press_enter: true }),
      display800x600,
    );
    expect(step.action).toEqual({
      kind: "type",
      text: "hello",
      x: 200, // 250/1000 * 800
      y: 300, // 500/1000 * 600
      pressEnter: true,
      consequence: "benign",
    });
  });

  it("maps type_text_at without press_enter to a non-submitting type", () => {
    const step = parseGeminiComputerUseResponse(
      functionCallResponse("type_text_at", { x: 0, y: 0, text: "draft" }),
      display800x600,
    );
    expect(step.action).toMatchObject({ kind: "type", text: "draft", pressEnter: false });
  });

  it("maps key_combination to a key Action carrying the combo", () => {
    const step = parseGeminiComputerUseResponse(
      functionCallResponse("key_combination", { keys: "ctrl+c" }),
      display800x600,
    );
    expect(step.action).toEqual({ kind: "key", combo: "ctrl+c", consequence: "benign" });
  });

  it("maps scroll_at to a scroll at the denormalised point with direction and magnitude", () => {
    const step = parseGeminiComputerUseResponse(
      functionCallResponse("scroll_at", { x: 500, y: 1000, direction: "down", magnitude: 4 }),
      display800x600,
    );
    expect(step.action).toEqual({
      kind: "scroll",
      x: 400,
      y: 600,
      direction: "down",
      amount: 4,
      consequence: "benign",
    });
  });

  it("maps scroll_document to a scroll at the display centre", () => {
    const step = parseGeminiComputerUseResponse(
      functionCallResponse("scroll_document", { direction: "up" }),
      display800x600,
    );
    expect(step.action).toMatchObject({ kind: "scroll", x: 400, y: 300, direction: "up" });
  });

  it("maps browser-navigation and passive functions to a no-op observe", () => {
    for (const passiveFunction of ["wait_5_seconds", "hover_at", "open_web_page", "go_back", "search", "some_future_fn"]) {
      const step = parseGeminiComputerUseResponse(
        functionCallResponse(passiveFunction, {}),
        display800x600,
      );
      expect(step.action).toEqual({ kind: "observe", consequence: "benign" });
    }
  });

  it("returns a done Action with the concatenated text when the model calls no function", () => {
    const rawResponse = JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "Filled it in. " }, { text: "Done." }] } }],
    });
    const step = parseGeminiComputerUseResponse(rawResponse, display800x600);
    expect(step.action).toEqual({ kind: "done", finalText: "Filled it in. Done." });
    expect(step.functionName).toBeUndefined();
  });

  it("preserves the model content for conversation continuity", () => {
    const step = parseGeminiComputerUseResponse(
      functionCallResponse("click_at", { x: 100, y: 100 }),
      display800x600,
    );
    expect(step.modelContent).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "click_at", args: { x: 100, y: 100 } } }],
    });
  });
});

describe("Gemini request construction", () => {
  it("builds the first user turn from the goal and screenshot", () => {
    const content = initialUserContent("do the thing", { base64Data: "IMG", mediaType: "image/png" });
    expect(content).toEqual({
      role: "user",
      parts: [
        { text: "do the thing" },
        { inlineData: { mimeType: "image/png", data: "IMG" } },
      ],
    });
  });

  it("feeds a follow-up screenshot back as a functionResponse referencing the pending function", () => {
    const content = functionResponseContent("click_at", { base64Data: "IMG2", mediaType: "image/jpeg" });
    expect(content.role).toBe("user");
    // The functionResponse names the function whose result this screenshot is.
    expect(content.parts[0]).toMatchObject({ functionResponse: { name: "click_at" } });
    // The screenshot itself rides along as inline image data.
    const inlineDataPart = content.parts.find((part) => "inlineData" in part) as
      | { inlineData: { mimeType: string; data: string } }
      | undefined;
    expect(inlineDataPart?.inlineData).toEqual({ mimeType: "image/jpeg", data: "IMG2" });
  });

  it("declares the computerUse tool and the system instruction", () => {
    const request = buildGeminiComputerUseRequest({
      contents: [initialUserContent("x", { base64Data: "IMG", mediaType: "image/png" })],
      systemPrompt: "you are lune",
    });
    expect(request.systemInstruction).toEqual({ parts: [{ text: "you are lune" }] });
    expect(request.tools[0]).toHaveProperty("computerUse");
    expect(request.contents).toHaveLength(1);
  });
});
