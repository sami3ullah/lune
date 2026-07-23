/**
 * A cheap, real test call that tells the onboarding key step whether a Vendor API key
 * actually works (ticket 14: "at least one Vendor, live-validated with a cheap test
 * call"). It reuses the exact request path a real turn uses - the Vendor adapter builds
 * its native upstream request - but with a one-token prompt and no screenshots, so the
 * call costs almost nothing and only its HTTP status matters. The verdict is a plain,
 * specific reason the user can act on (rejected key, rate limit, offline) rather than a
 * raw status code.
 *
 * It lives in the Core, over the same injected `upstreamFetch` seam as the Reasoning
 * pipeline, so a test validates it with a canned response and no network (Testing
 * Decisions: the upstream fetch seam is the one stubbed Vendor boundary). The Electron
 * main process injects the platform `fetch`; a future HTTP adapter would wrap the same
 * function.
 */
import { textOnlyChatRequest } from "./chatTypes.js";
import type { ReasoningVendor } from "./cloudReasoningVendors.js";
import type { UpstreamFetch } from "./upstreamFetch.js";

/** The verdict of a cheap key-validation call: usable, or an explained rejection. */
export type KeyValidationResult = { ok: true } | { ok: false; reason: string };

export interface ValidateReasoningKeyInput {
  /** The Vendor to test the key against (its adapter shapes the native request). */
  vendor: ReasoningVendor;
  /** The candidate API key. */
  apiKey: string;
  /** The Model Slot the test call requests; defaults to the Vendor's default model. */
  modelSlot?: string;
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
  /** Cancels the in-flight validation call when signalled. */
  signal?: AbortSignal;
}

/** The one-word prompt + single-token cap that keeps the validation call as cheap as possible. */
const VALIDATION_PROMPT = "Hi";
const VALIDATION_MAX_TOKENS = 1;

/** Trims a Vendor error body to a short, human-readable snippet for the reason line. */
function truncateDetail(detail: string): string {
  const collapsed = detail.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

/**
 * Validates a Vendor API key with a cheap real call. Returns `{ ok: true }` when the
 * Vendor accepts the request, or `{ ok: false, reason }` with a plain-language reason
 * when the key is rejected (401/403), rate-limited (429), the Vendor errors otherwise,
 * or the Vendor is unreachable. An `AbortError` from the signal is rethrown so the
 * caller can tell a cancellation apart from a rejection.
 */
export async function validateReasoningKey(input: ValidateReasoningKeyInput): Promise<KeyValidationResult> {
  const { vendor, upstreamFetch, signal } = input;
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    return { ok: false, reason: "Enter an API key to continue." };
  }

  const modelSlot = input.modelSlot ?? vendor.defaultModel;
  const upstreamRequest = vendor.buildUpstreamRequest({
    request: { ...textOnlyChatRequest(VALIDATION_PROMPT), maxTokens: VALIDATION_MAX_TOKENS },
    downscaledScreenshots: [],
    modelSlot,
    apiKey,
  });

  let response: Response;
  try {
    response = await upstreamFetch(upstreamRequest.url, {
      method: "POST",
      headers: upstreamRequest.headers,
      body: upstreamRequest.body,
      signal,
    });
  } catch (error) {
    // A deliberate cancellation is not a rejection - let the caller handle it.
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    return {
      ok: false,
      reason: `Couldn't reach ${vendor.displayName}. Check your internet connection and try again.`,
    };
  }

  if (response.ok) {
    // Only the status matters; drop the (streamed) body so this cheap call never lingers
    // as a half-read connection.
    await response.body?.cancel().catch(() => {});
    return { ok: true };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: `That ${vendor.displayName} key was rejected. Double-check that you copied the whole key.`,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      reason: `${vendor.displayName} is rate-limiting this key right now. Wait a moment and try again.`,
    };
  }

  const detail = truncateDetail(await response.text().catch(() => ""));
  return {
    ok: false,
    reason: `${vendor.displayName} rejected the request (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
  };
}
