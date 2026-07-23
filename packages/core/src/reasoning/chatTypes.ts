/**
 * The Core's Vendor-independent Reasoning request and stream-event types, plus the
 * screenshot-downscale seam the pipeline is built on.
 *
 * These are the Core's *native* shapes - not any one Vendor's wire format. A
 * request carries the conversation history, the current turn's screenshots and
 * text, and an optional system prompt; each Vendor adapter (`cloudReasoningVendors`)
 * translates this into that Vendor's own protocol. Modelling the request natively
 * (rather than as a JSON string, the way v1's HTTP Sidecar did) is what keeps the
 * Core transport-agnostic: the Electron main process hands it a typed object and a
 * future HTTP adapter parses one before the call.
 */

/** An inline screenshot the user is asking about, decoded from the current turn. */
export interface Screenshot {
  /** Base64-encoded image bytes (no `data:` prefix). */
  base64Data: string;
  /** The image's MIME type, e.g. `image/jpeg` or `image/png`. */
  mediaType: string;
}

/**
 * A downscaled screenshot plus the factor it was scaled by. `scaleFactor` is the
 * downscaled-to-original ratio in (0, 1] - e.g. 0.5 means the image was halved in
 * each dimension - and is exactly what the coordinate remapper divides by to map a
 * model coordinate in downscaled space back to real screenshot-pixel space. A
 * passthrough (no resize) reports 1.0.
 */
export interface DownscaledScreenshot {
  base64Data: string;
  mediaType: string;
  scaleFactor: number;
}

/**
 * Downscales one screenshot moderately before it is sent to the Reasoning Vendor,
 * to help latency/memory without wrecking grounding accuracy. Injected so the
 * pipeline's coordinate-remapping logic is tested with a known factor and the real
 * pixel-resizing edge (a Shell/main-process concern, not the Core's) stays thin.
 * The walking skeleton wires a passthrough (factor 1) until screen capture lands.
 */
export type DownscaleScreenshot = (screenshot: Screenshot) => Promise<DownscaledScreenshot>;

/** A text block in a chat message. */
export interface CoreTextBlock {
  type: "text";
  text: string;
}

/** A screenshot block in a chat message (the current turn's screen context). */
export interface CoreImageBlock {
  type: "image";
  base64Data: string;
  mediaType: string;
}

export type CoreContentBlock = CoreTextBlock | CoreImageBlock;

/**
 * One chat message. Conversation history carries plain-string content; the current
 * turn carries a block array (screenshots + text) so screen context and question
 * travel together.
 */
export interface CoreChatMessage {
  role: "user" | "assistant";
  content: string | CoreContentBlock[];
}

/** One chat turn handed to the Reasoning Capability. */
export interface CoreChatRequest {
  /** The persona + Point Tag grammar; falls back to the Core's canonical prompt when absent. */
  system?: string;
  /** Conversation history followed by the current turn. */
  messages: CoreChatMessage[];
  /** Upper bound on the answer length; the Vendor's default is used when absent. */
  maxTokens?: number;
}

/**
 * A streamed event of one chat turn, in the Core's canonical Vendor-independent
 * shape: zero or more `text-delta`s carrying the answer token-by-token (with any
 * Point Tag already repaired and remapped), closed by exactly one `done`. Failures
 * are thrown, not yielded, so the caller's `for await` either drains a complete
 * answer or throws.
 */
export type CoreChatStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "done" };

/**
 * Builds a text-only chat request (one user turn, no screenshots, no history) from
 * a bare prompt. This is what the Electron main process hands the Capability today:
 * the walking skeleton's IPC contract carries a prompt only, and screen context +
 * history join the request when screen capture lands. The Capability still runs the
 * full pipeline - a text-only request simply has no screenshots to downscale.
 */
export function textOnlyChatRequest(prompt: string): CoreChatRequest {
  return { messages: [{ role: "user", content: prompt }] };
}
