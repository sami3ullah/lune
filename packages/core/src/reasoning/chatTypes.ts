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
  /**
   * Asks the Vendor to spend as little hidden "reasoning"/"thinking" as it allows.
   * Set on small machine-read calls (mark refinement) where a reasoning-mode Model
   * Slot's default deliberation adds seconds of latency for no accuracy gain. Each
   * Vendor adapter maps it to its own wire knob where one exists (the OpenAI-compatible
   * `reasoning_effort`); Anthropic runs without thinking unless asked, so it needs no
   * mapping. Absent on ordinary conversational turns - the Vendor's default wins.
   */
  reasoningEffort?: "minimal";
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

/**
 * One captured display the Shell attaches to a chat turn: its screenshot bytes plus
 * a semantic label ("screen 1 of 2 - cursor is on this screen (primary focus)") and
 * the captured pixel dimensions. The Shell owns the OS-and-pixels work of producing
 * these; the Core owns how they become a request. Dimensions are the *captured*
 * pixels (pre-downscale) - the pipeline's downscale later rewrites them to the size
 * the model actually receives, so the model's coordinate space matches its image.
 */
export interface ScreenCaptureInput {
  /** Base64-encoded image bytes (no `data:` prefix). */
  base64Data: string;
  /** The image's MIME type, e.g. `image/jpeg`. */
  mediaType: string;
  /** The screenshot's width in captured pixels (before any downscale). */
  widthInPixels: number;
  /** The screenshot's height in captured pixels (before any downscale). */
  heightInPixels: number;
  /**
   * The Shell's semantic label for this display - which screen it is, whether the
   * cursor is on it (primary focus). Carries no dimensions; the builder appends them.
   */
  label: string;
}

/**
 * Builds a screen-aware chat request (one user turn) from a prompt and the displays
 * the Shell captured. Each screenshot is paired with its own text label so the model
 * reads the two together, and the prompt closes the turn:
 *
 *   [image screen 1] [label screen 1] [image screen 2] [label screen 2] ... [prompt]
 *
 * Each label states the screenshot's captured dimensions in the exact
 * `<width>x<height> pixels` form the pipeline's downscale rewrite matches, so the
 * Point Tag coordinate space the model is told about tracks the (possibly
 * downscaled) image it actually sees. With no captures this is exactly
 * {@link textOnlyChatRequest} - a screen-aware turn with nothing to show is a
 * text-only turn.
 */
export function screenAwareChatRequest(
  prompt: string,
  screens: ScreenCaptureInput[],
): CoreChatRequest {
  if (screens.length === 0) {
    return textOnlyChatRequest(prompt);
  }

  const content: CoreContentBlock[] = [];
  for (const screen of screens) {
    content.push({ type: "image", base64Data: screen.base64Data, mediaType: screen.mediaType });
    content.push({
      type: "text",
      text: `${screen.label} (image dimensions: ${screen.widthInPixels}x${screen.heightInPixels} pixels)`,
    });
  }
  content.push({ type: "text", text: prompt });

  return { messages: [{ role: "user", content }] };
}
