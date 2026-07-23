/**
 * The Gemini Reasoning Vendor's transport parameters.
 *
 * Gemini exposes an OpenAI-compatible chat-completions surface, so talking to it
 * is: POST an OpenAI-shaped request to its endpoint carrying the key as a Bearer
 * token, and read back an OpenAI-compatible SSE stream. This is the minimal slice
 * of v1's Vendor table (`cloudReasoningVendors.ts`) the walking skeleton needs -
 * Gemini only. Anthropic, OpenAI, and the routing/config that selects among them
 * are ported in later tickets; the table shape is preserved so adding a Vendor
 * stays a table entry, not a new integration.
 */
export interface CloudReasoningVendor {
  /** The flattened provider id that selects this Vendor. */
  id: "google";
  /** Human-readable name, for logs and error messages. */
  displayName: string;
  /** The chat-completions endpoint the OpenAI-shaped request is POSTed to. */
  chatCompletionsUrl: string;
  /** Builds the auth header(s) that carry the Vendor's API key on each request. */
  authHeaders: (apiKey: string) => Record<string, string>;
  /**
   * The Vendor's sensible-default model id, used when no explicit Model Slot is
   * configured. Overridable per deployment (the main process reads an env override
   * in the walking skeleton); the routing config becomes the source of truth in a
   * later ticket.
   */
  defaultModel: string;
}

/**
 * Google Gemini over its OpenAI-compatible endpoint: same chat-completions shape,
 * Bearer auth carrying the Gemini API key.
 */
export const GEMINI_VENDOR: CloudReasoningVendor = {
  id: "google",
  displayName: "Google Gemini",
  chatCompletionsUrl:
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  authHeaders: (apiKey: string) => ({ authorization: `Bearer ${apiKey}` }),
  defaultModel: "gemini-2.5-flash",
};
