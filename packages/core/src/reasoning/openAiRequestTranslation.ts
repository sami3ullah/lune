/**
 * Translates the Core's native chat request into the OpenAI-compatible
 * chat-completion request the OpenAI and Gemini Vendors expect. This is pure
 * transport adaptation: the persona, the Point Tag grammar, and the meaning are
 * unchanged; only the wire shape differs.
 *
 * The downscale-aware work (which downscaled bytes go where, and rewriting the
 * stated dimensions) is shared with every Vendor in `messagePreparation`; this
 * module only maps the normalized blocks onto OpenAI's content parts and prepends
 * the system message (falling back to the Core's canonical prompt when absent).
 *
 * Carried from v1's Sidecar (`reasoning/anthropicToOpenAiTranslation.ts`), adapted
 * to consume the Core's native `CoreChatRequest` instead of a parsed JSON string.
 */
import { CANONICAL_SYSTEM_PROMPT } from "./canonicalSystemPrompt.js";
import { prepareMessages, type PreparedContentBlock } from "./messagePreparation.js";
import type { CoreChatRequest, DownscaledScreenshot } from "./chatTypes.js";
import type {
  OpenAiChatMessage,
  OpenAiChatRequest,
  OpenAiContentPart,
  TokenLimitField,
} from "./openAiWire.js";

/**
 * The default completion budget when the request states none. It must cover a
 * reasoning model's hidden reasoning tokens *plus* the visible answer, because those
 * count against the same limit: a budget sized only for the (deliberately short,
 * one-or-two-sentence) spoken answer would be spent entirely on reasoning, and the
 * model would return an empty completion - a silent no-reply. The visible answer
 * stays short regardless (the canonical prompt caps its length), so a generous limit
 * costs nothing for non-reasoning models while giving reasoning models the headroom
 * they need.
 */
const DEFAULT_COMPLETION_TOKENS = 4096;

/** Maps one normalized content block onto its OpenAI wire shape. */
function toOpenAiContentPart(block: PreparedContentBlock): OpenAiContentPart {
  if (block.kind === "image") {
    return {
      type: "image_url",
      image_url: { url: `data:${block.mediaType};base64,${block.base64Data}` },
    };
  }
  return { type: "text", text: block.text };
}

/**
 * Builds the OpenAI chat request from the Core request and the pre-downscaled
 * screenshots. `modelSlot` is the model id to request; the system prompt is the one
 * the request carries, falling back to the Core's canonical prompt when absent.
 */
export function buildOpenAiChatRequest(options: {
  request: CoreChatRequest;
  downscaledScreenshots: DownscaledScreenshot[];
  modelSlot: string;
  /** Which completion-limit field this Vendor accepts (OpenAI vs Gemini differ). */
  tokenLimitField: TokenLimitField;
}): OpenAiChatRequest {
  const { request, downscaledScreenshots, modelSlot, tokenLimitField } = options;

  const messages: OpenAiChatMessage[] = [
    { role: "system", content: request.system ?? CANONICAL_SYSTEM_PROMPT },
  ];

  for (const preparedMessage of prepareMessages({ request, downscaledScreenshots })) {
    messages.push(
      typeof preparedMessage.content === "string"
        ? { role: preparedMessage.role, content: preparedMessage.content }
        : { role: preparedMessage.role, content: preparedMessage.content.map(toOpenAiContentPart) },
    );
  }

  return {
    model: modelSlot,
    stream: true,
    // The limit travels under whichever field name the Vendor accepts; the other stays unset.
    [tokenLimitField]: request.maxTokens ?? DEFAULT_COMPLETION_TOKENS,
    messages,
  };
}
