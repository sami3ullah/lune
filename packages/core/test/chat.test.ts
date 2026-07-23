import { describe, expect, it, vi } from "vitest";
import {
  ChatNotReadyError,
  createChatCapability,
  GEMINI_VENDOR,
  type CoreChatStreamEvent,
  type UpstreamFetch,
} from "../src/index";

// This is the successor of v1's cloud-reasoning Endpoint Contract tests, with HTTP
// removed: it calls the Core's public chat API exactly as the Electron main process
// does and asserts on the streamed events, stubbing only the injected upstream-fetch
// boundary so no network and no real key are involved (Testing Decisions).

/** Builds a canned OpenAI-compatible chat-completions SSE stream from text chunks. */
function cannedOpenAiSseResponse(contentChunks: string[]): Response {
  const sseLines = [
    // The role-only opening delta the adapter must skip.
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}`,
    ...contentChunks.map(
      (chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}`,
    ),
    "data: [DONE]",
  ];
  // Two trailing newlines per event, matching real SSE framing.
  const body = sseLines.map((line) => `${line}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Drains a chat turn into the ordered list of events it produced. */
async function collectChatEvents(
  stream: AsyncGenerator<CoreChatStreamEvent>,
): Promise<CoreChatStreamEvent[]> {
  const collectedEvents: CoreChatStreamEvent[] = [];
  for await (const event of stream) {
    collectedEvents.push(event);
  }
  return collectedEvents;
}

describe("Core chat Capability (Gemini walking skeleton)", () => {
  it("streams the Vendor's SSE deltas as canonical text-delta events then done", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>().mockResolvedValue(
      cannedOpenAiSseResponse(["Hello", ", ", "world"]),
    );
    const chatCapability = createChatCapability({
      upstreamFetch,
      getApiKey: () => "test-gemini-key",
      getModelSlot: () => "gemini-2.5-flash",
    });

    const events = await collectChatEvents(
      chatCapability.streamChat({ prompt: "Say hello" }),
    );

    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: ", " },
      { type: "text-delta", text: "world" },
      { type: "done" },
    ]);
  });

  it("posts an OpenAI-shaped streaming request to the Gemini endpoint with Bearer auth", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>().mockResolvedValue(
      cannedOpenAiSseResponse(["ok"]),
    );
    const chatCapability = createChatCapability({
      upstreamFetch,
      getApiKey: () => "test-gemini-key",
      getModelSlot: () => "gemini-2.5-flash",
    });

    await collectChatEvents(chatCapability.streamChat({ prompt: "What is on my screen?" }));

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = upstreamFetch.mock.calls[0]!;
    expect(calledUrl).toBe(GEMINI_VENDOR.chatCompletionsUrl);
    expect(calledInit?.method).toBe("POST");
    expect((calledInit?.headers as Record<string, string>).authorization).toBe(
      "Bearer test-gemini-key",
    );
    expect(JSON.parse(String(calledInit?.body))).toEqual({
      model: "gemini-2.5-flash",
      stream: true,
      messages: [{ role: "user", content: "What is on my screen?" }],
    });
  });

  it("throws ChatNotReadyError without any upstream call when no key is present", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const chatCapability = createChatCapability({
      upstreamFetch,
      getApiKey: () => undefined,
      getModelSlot: () => "gemini-2.5-flash",
    });

    await expect(
      collectChatEvents(chatCapability.streamChat({ prompt: "hi" })),
    ).rejects.toBeInstanceOf(ChatNotReadyError);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("throws with the Vendor's error body when the upstream request fails", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid model" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const chatCapability = createChatCapability({
      upstreamFetch,
      getApiKey: () => "test-gemini-key",
      getModelSlot: () => "does-not-exist",
    });

    await expect(
      collectChatEvents(chatCapability.streamChat({ prompt: "hi" })),
    ).rejects.toThrow(/invalid model/);
  });
});
