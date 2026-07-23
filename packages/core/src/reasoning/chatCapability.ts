/**
 * The Core's Reasoning `chat` Capability - the walking skeleton's single public
 * async-stream function (developer story 45).
 *
 * It ports the minimum-width slice of v1's shared Reasoning pipeline: build an
 * OpenAI-compatible chat request, stream the completion from the Vendor through
 * the injected `upstreamFetch` seam, and adapt the Vendor's OpenAI SSE into the
 * Core's canonical, Vendor-independent chat-event stream. The v1 pipeline's
 * screenshot downscale, Anthropic<->OpenAI translation, and Point Tag repair are
 * deliberately out of this slice - they arrive with screen-aware pointing.
 *
 * The Capability is credentials-gated exactly like v1's cloud Providers: with no
 * key present it throws {@link ChatNotReadyError} without making any upstream call,
 * so the Shell can surface "not ready" instead of hanging. The Core owns no
 * transport, no key storage, and no HTTP - the main process injects `fetch` and
 * the key; a test injects a stub `fetch` and a canned key.
 */
import { GEMINI_VENDOR } from "./geminiVendor.js";
import { iterateOpenAiContentDeltas } from "./openAiSse.js";
import type { UpstreamFetch } from "./upstreamFetch.js";

/** One chat turn handed to the Capability. Text only in the walking skeleton. */
export interface CoreChatRequest {
  /** The user's question. */
  prompt: string;
}

/**
 * A streamed event of one chat turn, in the Core's canonical Vendor-independent
 * shape: zero or more `text-delta`s carrying the answer token-by-token, closed by
 * exactly one `done`. Failures are thrown, not yielded (see {@link ChatNotReadyError}),
 * so the caller's `for await` either drains a complete answer or throws.
 */
export type CoreChatStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "done" };

/**
 * Thrown before any upstream call when the Capability has no credentials for its
 * Vendor. The direct successor of v1's 503 "not ready" for a credentials-gated
 * cloud Provider, expressed as a typed error now that the Core has no HTTP.
 */
export class ChatNotReadyError extends Error {
  constructor(vendorDisplayName: string) {
    super(`${vendorDisplayName} credentials are not configured`);
    this.name = "ChatNotReadyError";
  }
}

/** The injected boundaries the chat Capability is built from. */
export interface ChatCapabilityDependencies {
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
  /**
   * The Vendor's API key, read live so a key added after start takes effect
   * without rebuilding the Capability. `undefined` gates the Capability off.
   */
  getApiKey: () => string | undefined;
  /** The model id to request, read live from configuration. */
  getModelSlot: () => string;
}

/** The Core's chat Capability: a single streaming entry point. */
export interface ChatCapability {
  /**
   * Streams one chat turn's answer as canonical events. Throws
   * {@link ChatNotReadyError} (before any upstream call) when no key is present,
   * and throws if the Vendor rejects the request or the stream cannot be opened.
   */
  streamChat(request: CoreChatRequest): AsyncGenerator<CoreChatStreamEvent>;
}

/**
 * Builds the Gemini-backed chat Capability from its injected boundaries. Kept a
 * factory (rather than a bare function) so the injected seams are bound once and
 * the returned `streamChat` matches how a future multi-Vendor router would expose
 * the same shape.
 */
export function createChatCapability(
  dependencies: ChatCapabilityDependencies,
): ChatCapability {
  const { upstreamFetch, getApiKey, getModelSlot } = dependencies;

  async function* streamChat(
    request: CoreChatRequest,
  ): AsyncGenerator<CoreChatStreamEvent> {
    const apiKey = getApiKey();
    if (apiKey === undefined || apiKey.length === 0) {
      // Credentials-gating: no key -> not ready -> throw without any upstream call.
      throw new ChatNotReadyError(GEMINI_VENDOR.displayName);
    }

    const upstreamResponse = await upstreamFetch(GEMINI_VENDOR.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...GEMINI_VENDOR.authHeaders(apiKey),
      },
      body: JSON.stringify({
        model: getModelSlot(),
        stream: true,
        messages: [{ role: "user", content: request.prompt }],
      }),
    });

    if (!upstreamResponse.ok || upstreamResponse.body === null) {
      // Include the Vendor's own error body: it carries the actual reason (bad
      // model id, auth, rate limit) a bare status code would hide.
      const errorBody = await upstreamResponse.text().catch(() => "");
      throw new Error(
        `${GEMINI_VENDOR.displayName} chat completion failed: HTTP ${upstreamResponse.status}${errorBody ? ` - ${errorBody}` : ""}`,
      );
    }

    for await (const textDelta of iterateOpenAiContentDeltas(upstreamResponse.body)) {
      yield { type: "text-delta", text: textDelta };
    }

    yield { type: "done" };
  }

  return { streamChat };
}
