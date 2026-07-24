import { describe, expect, it, vi } from "vitest";

import {
  createScreenAgentCapability,
  createAnthropicComputerUseAdapter,
  createGeminiComputerUseAdapter,
  ScreenAgentNotReadyError,
  ScreenAgentStepInputError,
  type ComputerUseVendorId,
  type ReasoningVendorId,
  type RoutingConfig,
  type ScreenAgentCapability,
  type ScreenAgentStepInput,
  type UpstreamFetch,
} from "../src/index";

/**
 * Core-API tests (the seam the Electron main process drives) for the Screen Agent
 * Capability, the successor of v1's `POST /agent-step` Endpoint Contract tests with
 * HTTP removed: they drive `capability.step(...)` exactly as the main process does and
 * assert on the returned canonical Action and the recorded upstream calls, stubbing
 * only the injected `upstreamFetch` boundary so no network and no real key are
 * involved.
 *
 * These prove the ticket's acceptance criteria: stepping a session against a stubbed
 * Vendor returns exactly one canonical Action (or terminal done) per step with session
 * continuity, the floor escalates per its rules and never downgrades, and a
 * non-computer-use Vendor or a missing key yields a typed not-ready without touching
 * the network. Each canonical Action *kind*'s translation is proven exhaustively as a
 * pure unit in `anthropicComputerUse.test.ts` / `geminiComputerUse.test.ts`.
 */

/** An Anthropic Messages response whose assistant turn calls the computer tool. */
function toolUseResponse(options: {
  toolUseId: string;
  action: Record<string, unknown>;
  text?: string;
}): string {
  const content: unknown[] = [];
  if (options.text !== undefined) {
    content.push({ type: "text", text: options.text });
  }
  content.push({ type: "tool_use", id: options.toolUseId, name: "computer", input: options.action });
  return JSON.stringify({ role: "assistant", content, stop_reason: "tool_use" });
}

/** An Anthropic Messages response that only replies with text (the model is done). */
function doneResponse(text: string): string {
  return JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  });
}

/** A recorded outbound call the Capability made to its (stubbed) Vendor boundary. */
interface RecordedUpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A stub Vendor boundary that records every call and returns the given canned Vendor
 * responses in order (the last one repeats if more calls arrive).
 */
function makeStubUpstreamFetch(responses: string[]): {
  upstreamFetch: UpstreamFetch;
  recordedCalls: RecordedUpstreamCall[];
} {
  const recordedCalls: RecordedUpstreamCall[] = [];
  const upstreamFetch: UpstreamFetch = async (url, requestInit) => {
    const headerRecord: Record<string, string> = {};
    new Headers(requestInit?.headers).forEach((value, key) => {
      headerRecord[key] = value;
    });
    const rawBody = typeof requestInit?.body === "string" ? requestInit.body : null;
    recordedCalls.push({
      url,
      method: requestInit?.method ?? "GET",
      headers: headerRecord,
      body: rawBody === null ? null : JSON.parse(rawBody),
    });
    const responseBody = responses[Math.min(recordedCalls.length - 1, responses.length - 1)];
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { upstreamFetch, recordedCalls };
}

/** A config routing Reasoning to the given Vendor with a chosen Model Slot. */
function reasoningRouting(vendor: ReasoningVendorId, modelSlot: string): RoutingConfig {
  return {
    reasoning: { vendor, modelSlot },
    speech: { voice: "af_heart" },
    hotkey: { pushToTalk: "control+alt" },
  };
}

/** Boots a Screen Agent Capability with both adapters wired and the given per-Vendor keys. */
function bootCapability(options: {
  routingConfig: RoutingConfig;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  upstreamFetch: UpstreamFetch;
}): ScreenAgentCapability {
  const apiKeyByVendorId: Record<ComputerUseVendorId, () => string | undefined> = {
    anthropic: () => options.anthropicApiKey,
    google: () => options.geminiApiKey,
  };
  return createScreenAgentCapability({
    getRoutingConfig: () => options.routingConfig,
    adapters: {
      anthropic: createAnthropicComputerUseAdapter(),
      google: createGeminiComputerUseAdapter(),
    },
    getApiKey: (vendorId) => apiKeyByVendorId[vendorId](),
    upstreamFetch: options.upstreamFetch,
  });
}

/** A representative first-Step input: goal + display + first screenshot. */
function firstStep(sessionId: string): ScreenAgentStepInput {
  return {
    sessionId,
    goal: "reply thanking them",
    display: { width: 1440, height: 900 },
    screenshot: { base64Data: "SCREEN0", mediaType: "image/png" },
  };
}

/** A follow-up Step input: same session, a fresh screenshot, no goal. */
function followUpStep(sessionId: string, screenshotData: string): ScreenAgentStepInput {
  return {
    sessionId,
    screenshot: { base64Data: screenshotData, mediaType: "image/png" },
  };
}

describe("Screen Agent routed to the Anthropic computer-use Vendor", () => {
  it("translates a computer tool-use response into the canonical Action", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      toolUseResponse({ toolUseId: "toolu_1", action: { action: "left_click", coordinate: [420, 300] } }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      anthropicApiKey: "test-anthropic-key",
      upstreamFetch,
    });

    const action = await capability.step(firstStep("s1"));
    expect(action).toEqual({ kind: "click", x: 420, y: 300, consequence: "benign" });
  });

  it("sends the computer tool sized to the display, the config Model Slot, and the goal+screenshot", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      toolUseResponse({ toolUseId: "toolu_1", action: { action: "left_click", coordinate: [1, 2] } }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-opus-4-6"),
      anthropicApiKey: "test-anthropic-key",
      upstreamFetch,
    });

    await capability.step(firstStep("s1"));

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(recordedCalls[0].headers["x-api-key"]).toBe("test-anthropic-key");
    expect(recordedCalls[0].headers["anthropic-beta"]).toBe("computer-use-2025-01-24");
    const outbound = recordedCalls[0].body as {
      model: string;
      system: string;
      tools: Array<{ type: string; display_width_px: number; display_height_px: number }>;
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    };
    // The Core is the single source of truth for the model id (from the config).
    expect(outbound.model).toBe("claude-opus-4-6");
    expect(outbound.tools[0].type).toBe("computer_20250124");
    expect(outbound.tools[0].display_width_px).toBe(1440);
    expect(outbound.tools[0].display_height_px).toBe(900);
    expect(outbound.system.length).toBeGreaterThan(0);
    expect(outbound.messages[0].role).toBe("user");
    expect(outbound.messages[0].content[0]).toEqual({ type: "text", text: "reply thanking them" });
    expect(outbound.messages[0].content[1]).toMatchObject({ type: "image" });
  });

  it("advances one conversation across Steps, feeding the follow-up screenshot as the tool-result", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      toolUseResponse({ toolUseId: "toolu_1", action: { action: "left_click", coordinate: [10, 20] } }),
      toolUseResponse({ toolUseId: "toolu_2", action: { action: "type", text: "thanks!" } }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      anthropicApiKey: "test-anthropic-key",
      upstreamFetch,
    });

    await capability.step(firstStep("s1"));
    const secondAction = await capability.step(followUpStep("s1", "SCREEN1"));
    expect(secondAction).toEqual({ kind: "type", text: "thanks!", consequence: "benign" });

    // The second upstream request carries the whole conversation: the original user
    // turn, the assistant's tool_use, then the follow-up screenshot as a tool_result
    // referencing that exact tool_use id.
    expect(recordedCalls).toHaveLength(2);
    const secondOutbound = recordedCalls[1].body as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(secondOutbound.messages).toHaveLength(3);
    expect(secondOutbound.messages[1].role).toBe("assistant");
    const toolResultTurn = secondOutbound.messages[2];
    expect(toolResultTurn.role).toBe("user");
    expect(toolResultTurn.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    const toolResultContent = toolResultTurn.content[0].content as Array<{ type: string; source?: { data: string } }>;
    expect(toolResultContent[0]).toMatchObject({ type: "image" });
    expect(toolResultContent[0].source?.data).toBe("SCREEN1");
  });

  it("returns the terminal done Action with the final spoken text and ends the Session", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([doneResponse("Sent your reply. All done.")]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      anthropicApiKey: "test-anthropic-key",
      upstreamFetch,
    });

    const doneAction = await capability.step(firstStep("s1"));
    expect(doneAction.kind).toBe("done");
    expect(doneAction.kind === "done" && doneAction.finalText).toBe("Sent your reply. All done.");

    // The Session is gone: a follow-up on the same id (no goal) is now a fresh Session
    // that must be told a goal - proving the terminal transition cleared it.
    await expect(capability.step(followUpStep("s1", "SCREEN1"))).rejects.toBeInstanceOf(
      ScreenAgentStepInputError,
    );
  });

  it("throws not-ready without an upstream call when the Anthropic key is absent", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([doneResponse("unused")]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      anthropicApiKey: undefined,
      upstreamFetch,
    });

    await expect(capability.step(firstStep("s1"))).rejects.toBeInstanceOf(ScreenAgentNotReadyError);
    expect(recordedCalls).toHaveLength(0);
  });
});

describe("Screen Agent applies the escalate-only Consequence Level floor", () => {
  /** A first-Step input carrying a target signal alongside the goal + screenshot. */
  function firstStepWithSignal(sessionId: string, targetSignal: ScreenAgentStepInput["targetSignal"]): ScreenAgentStepInput {
    return { ...firstStep(sessionId), targetSignal };
  }

  it("escalates a model-benign click to consequential when its target is a Send button", async () => {
    // The stubbed model tags nothing (benign); the floor must escalate because the
    // element under the click coordinate is labelled Send.
    const { upstreamFetch } = makeStubUpstreamFetch([
      toolUseResponse({ toolUseId: "toolu_1", action: { action: "left_click", coordinate: [420, 300] } }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      anthropicApiKey: "test-anthropic-key",
      upstreamFetch,
    });

    const action = await capability.step(
      firstStepWithSignal("s1", {
        elements: [{ x: 400, y: 280, width: 100, height: 44, label: "Send", role: "AXButton" }],
      }),
    );
    expect(action.kind).toBe("click");
    expect(action.kind === "click" && action.consequence).toBe("consequential");
  });

  it("leaves a model-benign click benign when its target is an ordinary control", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      toolUseResponse({ toolUseId: "toolu_1", action: { action: "left_click", coordinate: [420, 300] } }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      anthropicApiKey: "test-anthropic-key",
      upstreamFetch,
    });

    const action = await capability.step(
      firstStepWithSignal("s1", {
        elements: [{ x: 400, y: 280, width: 100, height: 44, label: "Cancel", role: "AXButton" }],
      }),
    );
    expect(action.kind === "click" && action.consequence).toBe("benign");
  });

  it("leaves the Action benign when no target signal is supplied", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      toolUseResponse({ toolUseId: "toolu_1", action: { action: "left_click", coordinate: [420, 300] } }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      anthropicApiKey: "test-anthropic-key",
      upstreamFetch,
    });

    const action = await capability.step(firstStep("s1"));
    expect(action.kind === "click" && action.consequence).toBe("benign");
  });
});

describe("Screen Agent gating for non-computer-use Vendors", () => {
  // Google is computer-use-capable, so it is NOT here - its gating is on its own key,
  // covered in the Google suite below. OpenAI is the only advisory-only Reasoning
  // Vendor in Lune.
  it("throws not-ready without an upstream call when Reasoning is routed to OpenAI", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([doneResponse("unused")]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      anthropicApiKey: "test-anthropic-key",
      geminiApiKey: "test-gemini-key",
      upstreamFetch,
    });

    await expect(capability.step(firstStep("s1"))).rejects.toBeInstanceOf(ScreenAgentNotReadyError);
    expect(recordedCalls).toHaveLength(0);
  });

  it("throws not-ready without an upstream call when no adapter is wired for the routed Vendor", async () => {
    // Anthropic is a computer-use Vendor, but with no adapter registered the Screen
    // Agent still cannot act - not ready, no network.
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const capability = createScreenAgentCapability({
      getRoutingConfig: () => reasoningRouting("anthropic", "claude-sonnet-4-6"),
      adapters: {},
      getApiKey: () => "test-anthropic-key",
      upstreamFetch,
    });

    await expect(capability.step(firstStep("s1"))).rejects.toBeInstanceOf(ScreenAgentNotReadyError);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

/**
 * The Google/Gemini Vendor drives the same Capability through the same stubbed
 * `UpstreamFetch`, but its native surface differs, so these prove the Gemini-specific
 * translation over the seam: a `functionCall` becomes the right canonical Action with
 * 0-1000 coordinates denormalised to display pixels, the follow-up screenshot is fed
 * back as a `functionResponse`, the terminal transition works, and gating is on the
 * Gemini key. Exhaustive function-kind translation is a pure unit in
 * `geminiComputerUse.test.ts`.
 */
describe("Screen Agent routed to the Google (Gemini) computer-use Vendor", () => {
  /** A Gemini response whose model turn calls one computer-use function. */
  function functionCallResponse(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }],
    });
  }

  /** A Gemini response that only replies with text (the model is done). */
  function geminiDoneResponse(text: string): string {
    return JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
    });
  }

  const googleFirstStep: ScreenAgentStepInput = {
    sessionId: "g1",
    goal: "open the settings",
    display: { width: 1000, height: 1000 },
    screenshot: { base64Data: "SCREEN0", mediaType: "image/png" },
  };

  it("translates a Gemini functionCall into a canonical Action, targeting Gemini's endpoint", async () => {
    // Display 1000x1000, so a 0-1000 coordinate denormalises 1:1 for a clean assert.
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      functionCallResponse("click_at", { x: 640, y: 480 }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("google", "gemini-2.5-computer-use-preview-10-2025"),
      geminiApiKey: "test-gemini-key",
      upstreamFetch,
    });

    const action = await capability.step(googleFirstStep);
    expect(action).toEqual({ kind: "click", x: 640, y: 480, consequence: "benign" });

    // The outbound call goes to Gemini's generateContent endpoint with its own auth.
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-computer-use-preview-10-2025:generateContent",
    );
    expect(recordedCalls[0].headers["x-goog-api-key"]).toBe("test-gemini-key");
  });

  it("uses Google's dedicated computer-use model even when the advisory Model Slot is a chat model", async () => {
    // The user's Reasoning is routed to Google with an advisory vision model
    // (gemini-*-flash) as the Model Slot - that model cannot drive computer use, so
    // acting must fall back to Gemini's dedicated computer-use model, not the slot.
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      functionCallResponse("click_at", { x: 10, y: 10 }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("google", "gemini-3.5-flash-lite"),
      geminiApiKey: "test-gemini-key",
      upstreamFetch,
    });

    await capability.step(googleFirstStep);
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-computer-use-preview-10-2025:generateContent",
    );
  });

  it("denormalises 0-1000 coordinates to the bound display's pixels", async () => {
    // Display 800x600: x 500/1000*800 = 400, y 500/1000*600 = 300.
    const { upstreamFetch } = makeStubUpstreamFetch([functionCallResponse("click_at", { x: 500, y: 500 })]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("google", "gemini-2.5-computer-use-preview-10-2025"),
      geminiApiKey: "test-gemini-key",
      upstreamFetch,
    });

    const action = await capability.step({
      sessionId: "g1",
      goal: "click it",
      display: { width: 800, height: 600 },
      screenshot: { base64Data: "SCREEN0", mediaType: "image/png" },
    });
    expect(action.kind === "click" && action.x).toBe(400);
    expect(action.kind === "click" && action.y).toBe(300);
  });

  it("advances one conversation, feeding the follow-up screenshot as a functionResponse", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      functionCallResponse("click_at", { x: 100, y: 100 }),
      functionCallResponse("type_text_at", { x: 200, y: 200, text: "thanks", press_enter: false }),
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("google", "gemini-2.5-computer-use-preview-10-2025"),
      geminiApiKey: "test-gemini-key",
      upstreamFetch,
    });

    await capability.step(googleFirstStep);
    await capability.step(followUpStep("g1", "SCREEN1"));

    expect(recordedCalls).toHaveLength(2);
    const secondOutbound = recordedCalls[1].body as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    // The second request carries the whole conversation: the original user turn, the
    // model's functionCall turn, then the follow-up screenshot as a functionResponse.
    expect(secondOutbound.contents).toHaveLength(3);
    expect(secondOutbound.contents[1].role).toBe("model");
    const followUpTurn = secondOutbound.contents[2];
    expect(followUpTurn.role).toBe("user");
    expect(followUpTurn.parts[0]).toMatchObject({ functionResponse: { name: "click_at" } });
    const inlineDataPart = followUpTurn.parts.find((part) => "inlineData" in part) as
      | { inlineData: { data: string } }
      | undefined;
    expect(inlineDataPart?.inlineData.data).toBe("SCREEN1");
  });

  it("returns the terminal done Action and ends the Session", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([geminiDoneResponse("Opened settings for you.")]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("google", "gemini-2.5-computer-use-preview-10-2025"),
      geminiApiKey: "test-gemini-key",
      upstreamFetch,
    });

    const doneAction = await capability.step(googleFirstStep);
    expect(doneAction.kind).toBe("done");
    expect(doneAction.kind === "done" && doneAction.finalText).toBe("Opened settings for you.");

    await expect(capability.step(followUpStep("g1", "SCREEN1"))).rejects.toBeInstanceOf(
      ScreenAgentStepInputError,
    );
  });

  it("throws not-ready without an upstream call when the Gemini key is absent", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([geminiDoneResponse("unused")]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("google", "gemini-2.5-computer-use-preview-10-2025"),
      geminiApiKey: undefined,
      upstreamFetch,
    });

    await expect(capability.step(googleFirstStep)).rejects.toBeInstanceOf(ScreenAgentNotReadyError);
    expect(recordedCalls).toHaveLength(0);
  });
});
