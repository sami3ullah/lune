/**
 * The static table of cloud Reasoning Vendors (ADR: cloud-only Reasoning, three
 * Vendors). Each Vendor knows how to do two Vendor-specific things and nothing
 * else; the rest of the request path - screenshot downscale, coordinate remap,
 * Point Tag repair, canonical-stream adaptation - is the shared pipeline
 * (`reasoningPipeline.ts`), identical for every Vendor:
 *
 *   1. `buildUpstreamRequest` - shape the Vendor's native HTTP request (URL, auth
 *      header, body) from the pipeline-prepared (downscaled) Core request.
 *   2. `streamTextDeltas` - reduce the Vendor's SSE response body to a stream of
 *      raw answer-text deltas.
 *
 * OpenAI and Gemini share one OpenAI-compatible adapter differing only in URL,
 * auth, and default model - so adding another OpenAI-compatible Vendor is a table
 * entry, not a new integration. Anthropic has its own native adapter (Messages
 * API). Credentials-gating and Vendor selection live above this, in the Capability.
 *
 * Carried from v1's Sidecar Vendor table (`reasoning/cloudReasoningVendors.ts`),
 * generalized so the per-Vendor protocol - not just its transport parameters -
 * lives behind one seam, folding v1's separate Anthropic passthrough into the table.
 */
import { buildOpenAiChatRequest } from "./openAiRequestTranslation.js";
import { buildAnthropicChatRequest } from "./anthropicRequestTranslation.js";
import { iterateAnthropicTextDeltas, iterateOpenAiContentDeltas } from "./sseTextDeltas.js";
import type { CoreChatRequest, DownscaledScreenshot } from "./chatTypes.js";

/** The cloud Reasoning Vendors Lune can be routed to. */
export type ReasoningVendorId = "anthropic" | "openai" | "google";

/** The Core-side stable order of Vendors, e.g. for iterating the table. */
export const REASONING_VENDOR_IDS: readonly ReasoningVendorId[] = ["anthropic", "openai", "google"];

/** A Vendor's native upstream HTTP request, ready for the injected `upstreamFetch`. */
export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The pipeline-prepared inputs a Vendor turns into its native request. */
export interface BuildUpstreamRequestInput {
  request: CoreChatRequest;
  /** The request's screenshots, already downscaled (in order). */
  downscaledScreenshots: DownscaledScreenshot[];
  /** The Model Slot to request, from the routing config (the Core owns the model id). */
  modelSlot: string;
  /** The Vendor's API key (the Capability has already gated on its presence). */
  apiKey: string;
}

/** One cloud Reasoning Vendor: its identity plus its two protocol operations. */
export interface ReasoningVendor {
  id: ReasoningVendorId;
  /** Human-readable name, for logs and error messages. */
  displayName: string;
  /**
   * The Vendor's sensible-default model id, used as the routing config's default
   * Model Slot for this Vendor and preselected by the Shell's Settings picker.
   */
  defaultModel: string;
  /**
   * A curated shortlist of vision-capable Model Slots the Settings picker offers for
   * this Vendor (developer story 34). The Model Slot is free-text at the seam, so the
   * picker always also allows a custom entry; this is just the "sensible defaults"
   * list, with {@link defaultModel} always among them.
   */
  modelShortlist: readonly string[];
  /** Shapes the Vendor's native upstream HTTP request. */
  buildUpstreamRequest(input: BuildUpstreamRequestInput): UpstreamRequest;
  /** Reduces the Vendor's SSE response body to a stream of raw answer-text deltas. */
  streamTextDeltas(responseBody: ReadableStream<Uint8Array>): AsyncGenerator<string>;
}

/**
 * Builds an OpenAI-compatible Vendor (OpenAI, Gemini): the request is the shared
 * Anthropic->OpenAI translation POSTed with Bearer auth, and the response is an
 * OpenAI-compatible SSE stream. Only the endpoint URL and default model differ.
 */
function createOpenAiCompatibleVendor(parameters: {
  id: Extract<ReasoningVendorId, "openai" | "google">;
  displayName: string;
  chatCompletionsUrl: string;
  defaultModel: string;
  modelShortlist: readonly string[];
}): ReasoningVendor {
  return {
    id: parameters.id,
    displayName: parameters.displayName,
    defaultModel: parameters.defaultModel,
    modelShortlist: parameters.modelShortlist,
    buildUpstreamRequest: ({ request, downscaledScreenshots, modelSlot, apiKey }) => ({
      url: parameters.chatCompletionsUrl,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildOpenAiChatRequest({ request, downscaledScreenshots, modelSlot })),
    }),
    streamTextDeltas: iterateOpenAiContentDeltas,
  };
}

/** Anthropic over its native Messages API: base64 image blocks, `x-api-key` auth. */
const ANTHROPIC_VENDOR: ReasoningVendor = {
  id: "anthropic",
  displayName: "Anthropic",
  defaultModel: "claude-sonnet-4-6",
  modelShortlist: ["claude-sonnet-4-6", "claude-opus-4-1", "claude-haiku-4-5"],
  buildUpstreamRequest: ({ request, downscaledScreenshots, modelSlot, apiKey }) => ({
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(buildAnthropicChatRequest({ request, downscaledScreenshots, modelSlot })),
  }),
  streamTextDeltas: iterateAnthropicTextDeltas,
};

/**
 * Google Gemini over its OpenAI-compatible endpoint. The default is the
 * `gemini-flash-latest` alias, which Google keeps pointed at the current flash model
 * (the cheapest daily driver, per the Vendor decision), so the out-of-box choice keeps
 * working across Google's frequent model deprecations rather than 404-ing when a pinned
 * version is retired (as `gemini-2.5-flash` was, ahead of schedule, in July 2026). The
 * shortlist offers a pinned flash and the pro alias for users who want to pick explicitly.
 */
const GOOGLE_VENDOR: ReasoningVendor = createOpenAiCompatibleVendor({
  id: "google",
  displayName: "Google Gemini",
  chatCompletionsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  defaultModel: "gemini-flash-latest",
  modelShortlist: ["gemini-flash-latest", "gemini-3.5-flash", "gemini-pro-latest"],
});

/** OpenAI over its chat-completions endpoint. */
const OPENAI_VENDOR: ReasoningVendor = createOpenAiCompatibleVendor({
  id: "openai",
  displayName: "OpenAI",
  chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
  defaultModel: "gpt-4o",
  modelShortlist: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
});

/** The wired cloud Reasoning Vendors, keyed by id. */
export const REASONING_VENDORS: Record<ReasoningVendorId, ReasoningVendor> = {
  anthropic: ANTHROPIC_VENDOR,
  openai: OPENAI_VENDOR,
  google: GOOGLE_VENDOR,
};

/** Looks up a cloud Reasoning Vendor by its id. */
export function findReasoningVendor(vendorId: ReasoningVendorId): ReasoningVendor {
  return REASONING_VENDORS[vendorId];
}
