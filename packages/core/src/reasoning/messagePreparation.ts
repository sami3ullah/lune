/**
 * The Vendor-agnostic half of protocol translation, shared by every Vendor's
 * request builder: it walks the Core request once and resolves each content block
 * into a normalized, downscale-aware form - substituting the pre-downscaled image
 * bytes and rewriting the pixel dimensions stated in the text labels so the
 * coordinate space the model is told about matches the (smaller) image it sees.
 *
 * Each Vendor's builder then only maps these normalized blocks onto its own wire
 * shape (OpenAI content parts, or Anthropic image/text blocks) - so the "which
 * downscaled bytes go where, and how are the labels rewritten" decision lives in
 * exactly one place rather than being duplicated per Vendor. The inverse remap that
 * scales the model's returned coordinates back up lives in `pointTagCanonicalizer`.
 */
import type {
  CoreChatRequest,
  CoreContentBlock,
  DownscaledScreenshot,
  Screenshot,
} from "./chatTypes.js";

/**
 * A content block resolved to the bytes/text actually sent, independent of any
 * Vendor's wire shape: an image already carries its (downscaled) bytes, and a text
 * block already has its stated dimensions rewritten.
 */
export type PreparedContentBlock =
  | { kind: "image"; mediaType: string; base64Data: string }
  | { kind: "text"; text: string };

/** One message with its content resolved to {@link PreparedContentBlock}s (or plain history text). */
export interface PreparedMessage {
  role: "user" | "assistant";
  content: string | PreparedContentBlock[];
}

function isImageBlock(block: CoreContentBlock): block is Extract<CoreContentBlock, { type: "image" }> {
  return block.type === "image";
}

/** Every screenshot in the request, in the order the messages present them. */
export function extractScreenshots(request: CoreChatRequest): Screenshot[] {
  const screenshots: Screenshot[] = [];
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      continue;
    }
    for (const block of message.content) {
      if (isImageBlock(block)) {
        screenshots.push({ base64Data: block.base64Data, mediaType: block.mediaType });
      }
    }
  }
  return screenshots;
}

/**
 * Rewrites the "WxH pixels" dimensions stated in a label so they match the
 * downscaled image the model receives. Only rewrites when the image was actually
 * downscaled (`scaleFactor` < 1); at factor 1 the label is returned unchanged.
 */
function rewriteStatedDimensions(labelText: string, scaleFactor: number): string {
  if (scaleFactor >= 1) {
    return labelText;
  }
  return labelText.replace(
    /(\d+)\s*x\s*(\d+)(\s*pixels)/gi,
    (_whole, width: string, height: string, suffix: string) => {
      const scaledWidth = Math.round(Number.parseInt(width, 10) * scaleFactor);
      const scaledHeight = Math.round(Number.parseInt(height, 10) * scaleFactor);
      return `${scaledWidth}x${scaledHeight}${suffix}`;
    },
  );
}

/**
 * Resolves each of the request's content blocks to its normalized, downscale-aware
 * form: the pre-downscaled screenshots are substituted in the order they appear,
 * and each text label's stated dimensions are rewritten to the downscale factor.
 * Conversation history (plain-string content) passes through untouched.
 */
export function prepareMessages(options: {
  request: CoreChatRequest;
  downscaledScreenshots: DownscaledScreenshot[];
}): PreparedMessage[] {
  const { request, downscaledScreenshots } = options;
  // All screenshots share one uniform downscale factor, so the dimension rewrite
  // uses the same factor as the image substitution.
  const scaleFactor = downscaledScreenshots[0]?.scaleFactor ?? 1;

  const preparedMessages: PreparedMessage[] = [];
  let nextImageIndex = 0;
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      preparedMessages.push({ role: message.role, content: message.content });
      continue;
    }

    const preparedBlocks: PreparedContentBlock[] = [];
    for (const block of message.content) {
      if (isImageBlock(block)) {
        const downscaled = downscaledScreenshots[nextImageIndex];
        nextImageIndex += 1;
        // Fall back to the original bytes if (defensively) no downscaled image was
        // provided for this block, so a mismatch never drops the screenshot.
        preparedBlocks.push({
          kind: "image",
          mediaType: downscaled?.mediaType ?? block.mediaType,
          base64Data: downscaled?.base64Data ?? block.base64Data,
        });
      } else {
        preparedBlocks.push({ kind: "text", text: rewriteStatedDimensions(block.text, scaleFactor) });
      }
    }

    preparedMessages.push({ role: message.role, content: preparedBlocks });
  }

  return preparedMessages;
}
