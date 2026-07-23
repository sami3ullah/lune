import { describe, expect, it, vi } from "vitest";

import {
  ReasoningNotReadyError,
  createReasoningCapability,
  REASONING_VENDORS,
  type CoreChatRequest,
  type CoreChatStreamEvent,
  type DownscaleScreenshot,
  type ReasoningVendorId,
  type RoutingConfig,
  type UpstreamFetch,
} from "../src/index";

/**
 * The successor of v1's cloud-reasoning Endpoint Contract tests, with HTTP removed:
 * it drives the Core's public Reasoning Capability exactly as the Electron main
 * process does and asserts on the streamed events and the recorded upstream calls,
 * stubbing only the injected `upstreamFetch` and `downscaleScreenshot` boundaries
 * so no network and no real key are involved.
 *
 * These prove the four acceptance criteria of ticket 03: switching the configured
 * Vendor/Model Slot changes which upstream is called (and with which model + auth),
 * an absent key yields a typed not-ready result with no upstream call, and malformed
 * Point Tags are repaired with downscaled coordinates remapped (multi-screen too).
 */

/** An OpenAI streaming content-delta SSE line (what the OpenAI/Gemini Vendors emit). */
function openAiContentDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** An Anthropic Messages API text-delta SSE line. */
function anthropicTextDelta(text: string): string {
  return `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
}

/** A canned SSE Response streaming the given lines then closing. */
function cannedSseResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A recorded outbound call the Capability made to its (stubbed) Vendor boundary. */
interface RecordedUpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A stub Vendor boundary that records every call and returns a canned SSE stream. */
function makeStubUpstreamFetch(responseLines: string[]): {
  upstreamFetch: UpstreamFetch;
  recordedCalls: RecordedUpstreamCall[];
} {
  const recordedCalls: RecordedUpstreamCall[] = [];
  const upstreamFetch: UpstreamFetch = async (url, requestInit) => {
    const headerRecord: Record<string, string> = {};
    new Headers(requestInit?.headers).forEach((value, key) => {
      headerRecord[key] = value;
    });
    recordedCalls.push({
      url,
      method: requestInit?.method ?? "GET",
      headers: headerRecord,
      body: typeof requestInit?.body === "string" ? requestInit.body : null,
    });
    return cannedSseResponse(responseLines);
  };
  return { upstreamFetch, recordedCalls };
}

/** A downscale stub that halves each screenshot (scaleFactor 0.5). */
const halvingDownscale: DownscaleScreenshot = async (screenshot) => ({
  base64Data: `SMALL(${screenshot.base64Data})`,
  mediaType: screenshot.mediaType,
  scaleFactor: 0.5,
});

/** A passthrough downscale that leaves the screenshot untouched (scaleFactor 1). */
const passthroughDownscale: DownscaleScreenshot = async (screenshot) => ({
  ...screenshot,
  scaleFactor: 1,
});

/** A representative request with one dimensioned screenshot. */
function chatRequestWithScreenshot(): CoreChatRequest {
  return {
    system: "persona and grammar",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", base64Data: "BYTES", mediaType: "image/jpeg" },
          { type: "text", text: "primary focus (image dimensions: 1280x800 pixels)" },
          { type: "text", text: "how do i save?" },
        ],
      },
    ],
  };
}

/** Builds a Capability routed to `vendor` with the given per-Vendor keys present. */
function bootCapability(options: {
  routingConfig: RoutingConfig;
  apiKeys?: Partial<Record<ReasoningVendorId, string>>;
  upstreamFetch: UpstreamFetch;
  downscaleScreenshot?: DownscaleScreenshot;
}) {
  return createReasoningCapability({
    getRoutingConfig: () => options.routingConfig,
    getApiKey: (vendorId) => options.apiKeys?.[vendorId],
    upstreamFetch: options.upstreamFetch,
    downscaleScreenshot: options.downscaleScreenshot ?? halvingDownscale,
  });
}

/** Drains a chat turn into the concatenated answer text of its `text-delta` events. */
async function collectDeltaText(stream: AsyncGenerator<CoreChatStreamEvent>): Promise<string> {
  let text = "";
  for await (const event of stream) {
    if (event.type === "text-delta") {
      text += event.text;
    }
  }
  return text;
}

const reasoningRouting = (vendor: ReasoningVendorId, modelSlot: string): RoutingConfig => ({
  reasoning: { vendor, modelSlot },
  speech: { voice: "af_heart" },
  hotkey: { pushToTalk: "control+alt" },
});

describe("Reasoning routed to the OpenAI Vendor", () => {
  it("streams the answer as canonical text-delta events then done", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      openAiContentDelta("you can save from the file menu."),
      "data: [DONE]\n\n",
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      apiKeys: { openai: "sk-test-openai" },
      upstreamFetch,
    });

    const events: CoreChatStreamEvent[] = [];
    for await (const event of capability.streamChat(chatRequestWithScreenshot())) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.some((event) => event.type === "text-delta")).toBe(true);
    expect(
      events
        .filter((event): event is { type: "text-delta"; text: string } => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("you can save from the file menu.");
  });

  it("targets OpenAI's endpoint, carries Bearer auth, and sends the config Model Slot", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      openAiContentDelta("ok."),
      "data: [DONE]\n\n",
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("openai", "gpt-4.1-mini"),
      apiKeys: { openai: "sk-test-openai" },
      upstreamFetch,
    });

    await collectDeltaText(capability.streamChat(chatRequestWithScreenshot()));

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(recordedCalls[0].method).toBe("POST");
    expect(recordedCalls[0].headers.authorization).toBe("Bearer sk-test-openai");
    // The Core is the single source of truth for the model id (from the config).
    const outboundRequest = JSON.parse(recordedCalls[0].body ?? "{}") as { model?: string };
    expect(outboundRequest.model).toBe("gpt-4.1-mini");
  });

  it("repairs a malformed Point Tag and remaps its downscaled coordinates to real screen space", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      openAiContentDelta("that's the save button. "),
      // Sloppy tag in downscaled (half) space: 320,180 -> real 640,360.
      openAiContentDelta("[ point : 320 , 180 - save button : screen1 ]"),
      "data: [DONE]\n\n",
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      apiKeys: { openai: "sk-test-openai" },
      upstreamFetch,
    });

    expect(await collectDeltaText(capability.streamChat(chatRequestWithScreenshot()))).toBe(
      "that's the save button. [POINT:640,360:save button:screen1]",
    );
  });

  it("produces the exact canonical tag including a multi-screen index", async () => {
    const { upstreamFetch } = makeStubUpstreamFetch([
      // Downscaled (half) space on the second screen: 160,240 -> real 320,480.
      openAiContentDelta("look here [POINT:160,240:the toolbar:screen2]"),
      "data: [DONE]\n\n",
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      apiKeys: { openai: "sk-test-openai" },
      upstreamFetch,
    });

    expect(await collectDeltaText(capability.streamChat(chatRequestWithScreenshot()))).toBe(
      "look here [POINT:320,480:the toolbar:screen2]",
    );
  });
});

describe("switching the configured Vendor changes which upstream is called", () => {
  it("targets Gemini's endpoint with Bearer auth when routed to google", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      openAiContentDelta("ok."),
      "data: [DONE]\n\n",
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("google", "gemini-2.5-flash"),
      apiKeys: { google: "gemini-test-key" },
      upstreamFetch,
    });

    await collectDeltaText(capability.streamChat(chatRequestWithScreenshot()));

    expect(recordedCalls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(recordedCalls[0].headers.authorization).toBe("Bearer gemini-test-key");
    const outboundRequest = JSON.parse(recordedCalls[0].body ?? "{}") as { model?: string };
    expect(outboundRequest.model).toBe("gemini-2.5-flash");
  });

  it("targets Anthropic's Messages API with x-api-key and a native body when routed to anthropic", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      anthropicTextDelta("native answer. "),
      // Cloud Claude follows the grammar; the downscale remap still applies (half -> real).
      anthropicTextDelta("[POINT:160,240:the toolbar:screen2]"),
      "data: {\"type\":\"message_stop\"}\n\n",
    ]);
    const capability = bootCapability({
      routingConfig: reasoningRouting("anthropic", "claude-sonnet-4-6"),
      apiKeys: { anthropic: "test-anthropic-key" },
      upstreamFetch,
    });

    const answer = await collectDeltaText(capability.streamChat(chatRequestWithScreenshot()));

    expect(recordedCalls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(recordedCalls[0].headers["x-api-key"]).toBe("test-anthropic-key");
    expect(recordedCalls[0].headers["anthropic-version"]).toBe("2023-06-01");
    // Native Anthropic body: base64 image blocks + top-level system, and the config model.
    const outboundRequest = JSON.parse(recordedCalls[0].body ?? "{}") as {
      model?: string;
      system?: string;
      messages?: Array<{ content?: Array<{ type?: string }> }>;
    };
    expect(outboundRequest.model).toBe("claude-sonnet-4-6");
    expect(outboundRequest.system).toBe("persona and grammar");
    expect(outboundRequest.messages?.[0]?.content?.[0]?.type).toBe("image");
    // The answer is adapted identically: native SSE -> canonical events, remapped tag.
    expect(answer).toBe("native answer. [POINT:320,480:the toolbar:screen2]");
  });
});

describe("per-Vendor credentials gating", () => {
  it.each(["anthropic", "openai", "google"] as const)(
    "throws ReasoningNotReadyError without any upstream call when the %s key is absent",
    async (vendorId) => {
      const upstreamFetch = vi.fn<UpstreamFetch>();
      const capability = bootCapability({
        routingConfig: reasoningRouting(vendorId, REASONING_VENDORS[vendorId].defaultModel),
        apiKeys: {},
        upstreamFetch,
      });

      await expect(
        collectDeltaText(capability.streamChat(chatRequestWithScreenshot())),
      ).rejects.toBeInstanceOf(ReasoningNotReadyError);
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it("only gates on the routed Vendor's key, not another Vendor's", async () => {
    const { upstreamFetch, recordedCalls } = makeStubUpstreamFetch([
      openAiContentDelta("ok."),
      "data: [DONE]\n\n",
    ]);
    // OpenAI is routed and keyed; Anthropic's key is absent but irrelevant.
    const capability = bootCapability({
      routingConfig: reasoningRouting("openai", "gpt-4o"),
      apiKeys: { openai: "sk-test-openai" },
      upstreamFetch,
    });

    await collectDeltaText(capability.streamChat(chatRequestWithScreenshot()));
    expect(recordedCalls).toHaveLength(1);
  });
});

describe("upstream failure", () => {
  it("throws with the Vendor's error body when the upstream request fails", async () => {
    const upstreamFetch: UpstreamFetch = async () =>
      new Response(JSON.stringify({ error: "invalid model" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const capability = bootCapability({
      routingConfig: reasoningRouting("openai", "does-not-exist"),
      apiKeys: { openai: "sk-test-openai" },
      upstreamFetch,
      downscaleScreenshot: passthroughDownscale,
    });

    await expect(
      collectDeltaText(capability.streamChat(chatRequestWithScreenshot())),
    ).rejects.toThrow(/invalid model/);
  });
});
