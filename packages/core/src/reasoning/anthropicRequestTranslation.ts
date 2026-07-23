/**
 * Builds the Anthropic Messages API request from the Core's native chat request.
 *
 * Unlike v1 - which forwarded the Shell's Claude-shaped body to Anthropic verbatim
 * and never downscaled - the Core runs every Vendor through one shared pipeline: it
 * downscales screenshots uniformly and remaps the returned Point Tag coordinates.
 * That downscale-aware work is shared with every Vendor in `messagePreparation`;
 * this module only maps the normalized blocks onto Anthropic's native image/text
 * blocks and folds the system prompt into the top-level `system` field. No protocol
 * translation is needed - Anthropic already speaks the canonical grammar.
 */
import { CANONICAL_SYSTEM_PROMPT } from "./canonicalSystemPrompt.js";
import { prepareMessages, type PreparedContentBlock } from "./messagePreparation.js";
import type { CoreChatRequest, DownscaledScreenshot } from "./chatTypes.js";

/** An Anthropic base64 image content block. */
interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

/** An Anthropic text content block. */
interface AnthropicTextBlock {
  type: "text";
  text: string;
}

type AnthropicContentBlock = AnthropicImageBlock | AnthropicTextBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** The Anthropic Messages API request body. */
export interface AnthropicChatRequest {
  model: string;
  max_tokens: number;
  stream: true;
  system: string;
  messages: AnthropicMessage[];
}

/** Maps one normalized content block onto its Anthropic wire shape. */
function toAnthropicContentBlock(block: PreparedContentBlock): AnthropicContentBlock {
  if (block.kind === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: block.mediaType, data: block.base64Data },
    };
  }
  return { type: "text", text: block.text };
}

export function buildAnthropicChatRequest(options: {
  request: CoreChatRequest;
  downscaledScreenshots: DownscaledScreenshot[];
  modelSlot: string;
}): AnthropicChatRequest {
  const { request, downscaledScreenshots, modelSlot } = options;

  const messages: AnthropicMessage[] = prepareMessages({ request, downscaledScreenshots }).map(
    (preparedMessage) =>
      typeof preparedMessage.content === "string"
        ? { role: preparedMessage.role, content: preparedMessage.content }
        : { role: preparedMessage.role, content: preparedMessage.content.map(toAnthropicContentBlock) },
  );

  return {
    model: modelSlot,
    max_tokens: request.maxTokens ?? 1024,
    stream: true,
    system: request.system ?? CANONICAL_SYSTEM_PROMPT,
    messages,
  };
}
