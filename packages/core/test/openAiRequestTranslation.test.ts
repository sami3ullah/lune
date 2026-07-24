import { describe, expect, it } from "vitest";

import { buildOpenAiChatRequest } from "../src/reasoning/openAiRequestTranslation";
import { extractScreenshots } from "../src/reasoning/messagePreparation";
import { CANONICAL_SYSTEM_PROMPT } from "../src/reasoning/canonicalSystemPrompt";
import type { CoreChatRequest, DownscaledScreenshot } from "../src/reasoning/chatTypes";
import type { OpenAiContentPart } from "../src/reasoning/openAiWire";

/**
 * Unit tests for the Core-request -> OpenAI request translation: the transport
 * adaptation that lets the OpenAI and Gemini Vendors receive Lune's native chat
 * request, including the downscale substitution and stated-dimension rewrite.
 * Carried from v1's `anthropicToOpenAiTranslation` suite, adapted to the Core's
 * native (already-parsed) request shape.
 */

/** A representative request: history, a screenshot with a dimensioned label, and the question. */
const SAMPLE_REQUEST: CoreChatRequest = {
  system: "persona and point grammar",
  maxTokens: 1024,
  messages: [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    {
      role: "user",
      content: [
        { type: "image", base64Data: "ORIGINALBYTES", mediaType: "image/jpeg" },
        { type: "text", text: "primary focus (image dimensions: 1280x800 pixels)" },
        { type: "text", text: "how do i save this file?" },
      ],
    },
  ],
};

describe("extractScreenshots", () => {
  it("pulls out the screenshots in the order the messages present them", () => {
    expect(extractScreenshots(SAMPLE_REQUEST)).toEqual([
      { base64Data: "ORIGINALBYTES", mediaType: "image/jpeg" },
    ]);
  });

  it("returns no screenshots for a text-only request", () => {
    expect(extractScreenshots({ messages: [{ role: "user", content: "hi" }] })).toEqual([]);
  });
});

describe("buildOpenAiChatRequest", () => {
  it("maps system, history, and the current turn into OpenAI shape", () => {
    const downscaled: DownscaledScreenshot[] = [
      { base64Data: "SMALLBYTES", mediaType: "image/jpeg", scaleFactor: 0.5 },
    ];

    const openAiRequest = buildOpenAiChatRequest({
      request: SAMPLE_REQUEST,
      downscaledScreenshots: downscaled,
      modelSlot: "gpt-4o",
      tokenLimitField: "max_completion_tokens",
    });

    expect(openAiRequest.model).toBe("gpt-4o");
    expect(openAiRequest.stream).toBe(true);
    expect(openAiRequest.messages[0]).toEqual({ role: "system", content: "persona and point grammar" });
    // Conversation history carries through as plain-string messages.
    expect(openAiRequest.messages[1]).toEqual({ role: "user", content: "earlier question" });
    expect(openAiRequest.messages[2]).toEqual({ role: "assistant", content: "earlier answer" });
  });

  it("substitutes the downscaled image as a data URL and rewrites the stated dimensions", () => {
    const downscaled: DownscaledScreenshot[] = [
      { base64Data: "SMALLBYTES", mediaType: "image/jpeg", scaleFactor: 0.5 },
    ];

    const openAiRequest = buildOpenAiChatRequest({
      request: SAMPLE_REQUEST,
      downscaledScreenshots: downscaled,
      modelSlot: "gpt-4o",
      tokenLimitField: "max_completion_tokens",
    });

    const parts = openAiRequest.messages[3].content as OpenAiContentPart[];
    expect(parts[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,SMALLBYTES" },
    });
    // The label's dimensions are halved to match the downscaled image the model sees.
    expect(parts[1]).toEqual({
      type: "text",
      text: "primary focus (image dimensions: 640x400 pixels)",
    });
    expect(parts[2]).toEqual({ type: "text", text: "how do i save this file?" });
  });

  it("leaves stated dimensions unchanged when no downscaling was applied", () => {
    const downscaled: DownscaledScreenshot[] = [
      { base64Data: "ORIGINALBYTES", mediaType: "image/jpeg", scaleFactor: 1 },
    ];

    const openAiRequest = buildOpenAiChatRequest({
      request: SAMPLE_REQUEST,
      downscaledScreenshots: downscaled,
      modelSlot: "gpt-4o",
      tokenLimitField: "max_completion_tokens",
    });

    const parts = openAiRequest.messages[3].content as OpenAiContentPart[];
    expect(parts[1]).toEqual({
      type: "text",
      text: "primary focus (image dimensions: 1280x800 pixels)",
    });
  });

  it("falls back to the Core's canonical prompt when the request omits system", () => {
    const openAiRequest = buildOpenAiChatRequest({
      request: { messages: [{ role: "user", content: "hi" }] },
      downscaledScreenshots: [],
      modelSlot: "gpt-4o",
      tokenLimitField: "max_completion_tokens",
    });
    expect(openAiRequest.messages[0]).toEqual({ role: "system", content: CANONICAL_SYSTEM_PROMPT });
  });

  it("carries the completion limit under the Vendor's token-limit field, and only that one", () => {
    // OpenAI's reasoning families reject `max_tokens` and require `max_completion_tokens`;
    // Gemini's OpenAI-compatible surface still speaks `max_tokens`. Exactly one is set.
    const openAiRequest = buildOpenAiChatRequest({
      request: { messages: [{ role: "user", content: "hi" }], maxTokens: 777 },
      downscaledScreenshots: [],
      modelSlot: "gpt-5.4-mini",
      tokenLimitField: "max_completion_tokens",
    });
    expect(openAiRequest.max_completion_tokens).toBe(777);
    expect(openAiRequest.max_tokens).toBeUndefined();

    const geminiRequest = buildOpenAiChatRequest({
      request: { messages: [{ role: "user", content: "hi" }], maxTokens: 777 },
      downscaledScreenshots: [],
      modelSlot: "gemini-3.5-flash-lite",
      tokenLimitField: "max_tokens",
    });
    expect(geminiRequest.max_tokens).toBe(777);
    expect(geminiRequest.max_completion_tokens).toBeUndefined();
  });

  it("defaults the completion budget high enough to cover a reasoning model's hidden tokens", () => {
    // With no stated limit, a reasoning model's reasoning tokens plus the short spoken
    // answer must fit, so the default is generous rather than sized for the answer alone.
    const openAiRequest = buildOpenAiChatRequest({
      request: { messages: [{ role: "user", content: "hi" }] },
      downscaledScreenshots: [],
      modelSlot: "gpt-5.4-mini",
      tokenLimitField: "max_completion_tokens",
    });
    expect(openAiRequest.max_completion_tokens).toBeGreaterThanOrEqual(4096);
  });
});
