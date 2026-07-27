/**
 * The OpenAI-compatible chat-completions wire types the OpenAI and Gemini Vendor
 * adapters build. Gemini exposes an OpenAI-compatible surface, so both Vendors
 * share this one request shape - only the endpoint URL, auth header, and default
 * model differ (see `cloudReasoningVendors`). Anthropic uses its own native shape
 * and does not touch these types.
 */

/** An OpenAI chat message text content part. */
export interface OpenAiTextPart {
  type: "text";
  text: string;
}

/** An OpenAI chat message image content part (a `data:` URI carries the bytes). */
export interface OpenAiImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenAiContentPart = OpenAiTextPart | OpenAiImagePart;

/** One OpenAI-compatible chat message. Content is plain text or a parts array. */
export interface OpenAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAiContentPart[];
}

/**
 * The completion-length field name. OpenAI's own models retired `max_tokens` on the
 * chat-completions endpoint for the reasoning families (o-series, GPT-5+) - they
 * reject the request unless the limit is given as `max_completion_tokens` - while
 * Gemini's OpenAI-compatible surface still speaks `max_tokens`. So the field name is
 * per-Vendor, not a constant (see `cloudReasoningVendors`).
 */
export type TokenLimitField = "max_tokens" | "max_completion_tokens";

/**
 * The OpenAI-compatible chat-completion request POSTed to the Vendor. The completion
 * limit is carried under whichever of the two field names the Vendor accepts - only
 * one is ever set on a given request.
 */
export interface OpenAiChatRequest {
  model: string;
  stream: true;
  messages: OpenAiChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  /**
   * How much hidden reasoning the model spends before answering. Gemini's
   * OpenAI-compatible surface maps this to a thinking budget on every gemini model;
   * OpenAI accepts it only on its reasoning families and rejects it on the classic
   * gpt-4 models - so it is set per-model (see `modelSlotAcceptsReasoningEffort`),
   * and only when the Core request asks for minimal effort.
   */
  reasoning_effort?: "low";
}
