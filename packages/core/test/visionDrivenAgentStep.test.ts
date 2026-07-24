import { describe, expect, it } from "vitest";

import {
  createScreenAgentCapability,
  createVisionDrivenAgentAdapter,
  ScreenAgentNotReadyError,
  ScreenAgentStepInputError,
  VISION_DRIVEN_VENDORS,
  type ComputerUseVendorId,
  type ReasoningVendorId,
  type RoutingConfig,
  type ScreenAgentCapability,
  type ScreenAgentStepInput,
  type UpstreamFetch,
} from "../src/index";

/**
 * Core-API tests for the Screen Agent Capability driven through the *vision-driven*
 * adapter (M2-07) - the same seam `agentStep.test.ts` exercises for the native
 * computer-use adapters, but proving the M2-07 acceptance criteria: a keyed vision chat
 * model runs a session end to end on its ordinary chat Model Slot (no dedicated
 * computer-use model, no gated access); the JSON action grammar parses into the canonical
 * Action in display space; a `consequential` tag still trips the floor; session continuity
 * feeds the latest screenshot while trimming old ones; and a missing key yields a typed
 * not-ready with no upstream call. Exhaustive action-kind translation is a pure unit in
 * `visionDrivenAgent.test.ts`.
 */

/** A recorded outbound call the Capability made to its (stubbed) Vendor boundary. */
interface RecordedUpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stub Vendor boundary that records every call and returns canned bodies in order. */
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
    return new Response(responseBody, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { upstreamFetch, recordedCalls };
}

/** An OpenAI-compatible chat completion whose assistant reply is the given JSON action. */
function actionResponse(action: Record<string, unknown>): string {
  return JSON.stringify({
    id: "chatcmpl_1",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(action) }, finish_reason: "stop" }],
  });
}

/** A config routing Reasoning to the given Vendor with a chosen Model Slot. */
function reasoningRouting(vendor: ReasoningVendorId, modelSlot: string): RoutingConfig {
  return {
    reasoning: { vendor, modelSlot },
    speech: { voice: "af_heart" },
    hotkey: { pushToTalk: "control+alt" },
  };
}

/** Boots a Capability whose OpenAI slot is driven by the vision-driven adapter. */
function bootVisionCapability(options: {
  routingConfig: RoutingConfig;
  openaiApiKey?: string;
  upstreamFetch: UpstreamFetch;
}): ScreenAgentCapability {
  const apiKeyByVendorId: Partial<Record<ComputerUseVendorId, () => string | undefined>> = {
    openai: () => options.openaiApiKey,
  };
  return createScreenAgentCapability({
    getRoutingConfig: () => options.routingConfig,
    adapters: { openai: createVisionDrivenAgentAdapter(VISION_DRIVEN_VENDORS.openai) },
    getApiKey: (vendorId) => apiKeyByVendorId[vendorId]?.(),
    upstreamFetch: options.upstreamFetch,
  });
}

const firstStep: ScreenAgentStepInput = {
  sessionId: "v1",
  goal: "write a short joke in Notes",
  display: { width: 1440, height: 900 },
  screenshot: { base64Data: "SCREEN0", mediaType: "image/png" },
};

function followUpStep(screenshotData: string): ScreenAgentStepInput {
  return { sessionId: "v1", screenshot: { base64Data: screenshotData, mediaType: "image/png" } };
}

describe("Screen Agent driven by the vision-driven adapter on the OpenAI chat slot", () => {
  it("translates a JSON click into the canonical Action in display space, on the chat Model Slot", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      actionResponse({ action: "click", x: 420, y: 300, consequence: "benign" }),
    ]);
    const capability = bootVisionCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      openaiApiKey: "test-openai-key",
      upstreamFetch,
    });

    const action = await capability.step(firstStep);
    expect(action).toEqual({ kind: "click", x: 420, y: 300, consequence: "benign" });

    // The call hits the ordinary chat-completions endpoint with Bearer auth, and uses the
    // advisory chat Model Slot - NOT the dedicated computer-use-preview model.
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(recordedCalls[0].headers["authorization"]).toBe("Bearer test-openai-key");
    const outbound = recordedCalls[0].body as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(outbound.model).toBe("gpt-4o");
    expect(outbound.response_format).toEqual({ type: "json_object" });
    expect(outbound.messages[0].role).toBe("system");
    expect(outbound.messages[1].role).toBe("user");
  });

  it("escalates a model-benign click to consequential when its target is a Send button", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      actionResponse({ action: "click", x: 420, y: 300, consequence: "benign" }),
    ]);
    const capability = bootVisionCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      openaiApiKey: "test-openai-key",
      upstreamFetch,
    });

    const action = await capability.step({
      ...firstStep,
      targetSignal: { elements: [{ x: 400, y: 280, width: 100, height: 44, label: "Send", role: "AXButton" }] },
    });
    expect(action.kind === "click" && action.consequence).toBe("consequential");
  });

  it("keeps a model-tagged consequential action consequential through the floor", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      actionResponse({ action: "key", combo: "cmd+return", consequence: "consequential" }),
    ]);
    const capability = bootVisionCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      openaiApiKey: "test-openai-key",
      upstreamFetch,
    });

    const action = await capability.step(firstStep);
    expect(action.kind === "key" && action.consequence).toBe("consequential");
  });

  it("advances one conversation across Steps, feeding only the latest screenshot", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      actionResponse({ action: "click", x: 10, y: 20, consequence: "benign" }),
      actionResponse({ action: "type", text: "knock knock", consequence: "benign" }),
    ]);
    const capability = bootVisionCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      openaiApiKey: "test-openai-key",
      upstreamFetch,
    });

    await capability.step(firstStep);
    const secondAction = await capability.step(followUpStep("SCREEN1"));
    expect(secondAction).toEqual({ kind: "type", text: "knock knock", consequence: "benign" });

    // The second request carries the whole conversation - system, the first user turn
    // (now text-only, its screenshot trimmed), the assistant's action, then the follow-up
    // user turn with the fresh screenshot - so exactly one screenshot is ever in flight.
    expect(recordedCalls).toHaveLength(2);
    const secondOutbound = recordedCalls[1].body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const imageUrls = collectImageUrls(secondOutbound.messages);
    expect(imageUrls).toEqual(["data:image/png;base64,SCREEN1"]);
    // The assistant's prior action turn is present for continuity.
    expect(secondOutbound.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("returns the terminal done Action and ends the Session", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      actionResponse({ action: "done", finalText: "Wrote a joke in Notes for you." }),
    ]);
    const capability = bootVisionCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      openaiApiKey: "test-openai-key",
      upstreamFetch,
    });

    const doneAction = await capability.step(firstStep);
    expect(doneAction.kind).toBe("done");
    expect(doneAction.kind === "done" && doneAction.finalText).toBe("Wrote a joke in Notes for you.");

    // The Session is gone: a follow-up (no goal) is now a fresh Session needing a goal.
    await expect(capability.step(followUpStep("SCREEN1"))).rejects.toBeInstanceOf(ScreenAgentStepInputError);
  });

  it("throws not-ready without an upstream call when the OpenAI key is absent", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([actionResponse({ action: "observe", consequence: "benign" })]);
    const capability = bootVisionCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      openaiApiKey: undefined,
      upstreamFetch,
    });

    await expect(capability.step(firstStep)).rejects.toBeInstanceOf(ScreenAgentNotReadyError);
    expect(recordedCalls).toHaveLength(0);
  });
});

/** Collects every image_url the request's message content parts carry, in order. */
function collectImageUrls(messages: Array<{ role: string; content: unknown }>): string[] {
  const urls: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === "image_url" && part.image_url !== null && typeof part.image_url === "object") {
        const url = (part.image_url as { url?: unknown }).url;
        if (typeof url === "string") {
          urls.push(url);
        }
      }
    }
  }
  return urls;
}
