/**
 * Fetches a Vendor's live catalogue of available model ids, so the Settings picker can
 * offer the models the Vendor currently serves rather than a shortlist baked into the
 * code (which drifts as Vendors add and retire models). It reuses the same injected
 * `upstreamFetch` seam as the Reasoning pipeline and the key validator, so a test drives
 * it with a canned response and no network.
 *
 * All three Vendors expose an OpenAI-shaped list at their models endpoint - `{ data:
 * [{ id }] }` (Anthropic's `/v1/models` and Gemini's OpenAI-compat `/models` both match
 * OpenAI's) - so one parser covers every Vendor. The Vendor's curated shortlist is used
 * only to *order* the live list (its featured models float to the top when present),
 * never to pad it, so the returned catalogue is exactly what the Vendor reports.
 */
import type { ReasoningVendor } from "./cloudReasoningVendors.js";
import type { UpstreamFetch } from "./upstreamFetch.js";

/** The outcome of a model-listing call: the live model ids, or an explained failure. */
export type ModelListResult = { ok: true; models: string[] } | { ok: false; reason: string };

export interface ListReasoningModelsInput {
  /** The Vendor whose catalogue to fetch (its adapter shapes the native request). */
  vendor: ReasoningVendor;
  /** The Vendor's API key (the caller has already gated on its presence). */
  apiKey: string;
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
  /** Cancels the in-flight listing call when signalled. */
  signal?: AbortSignal;
}

/** Trims a Vendor error body to a short, human-readable snippet for the reason line. */
function truncateDetail(detail: string): string {
  const collapsed = detail.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

/**
 * Extracts the model ids from an OpenAI-shaped `{ data: [{ id }] }` list body, tolerating
 * anything off-shape by skipping it rather than throwing (a Vendor that adds fields, or a
 * stray non-object entry, still yields the ids it can find).
 */
function parseModelIds(body: unknown): string[] {
  if (body === null || typeof body !== "object") {
    return [];
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of data) {
    if (entry !== null && typeof entry === "object") {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && id.trim().length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Orders the live model ids so the Vendor's featured (shortlist) models appear first, in
 * shortlist order, and the rest follow alphabetically. Featured models that the Vendor
 * did not report are dropped (the list stays truthful to what is actually available);
 * duplicates are removed.
 */
function orderModels(modelIds: string[], featured: readonly string[]): string[] {
  const available = new Set(modelIds);
  const featuredPresent = featured.filter((id) => available.has(id));
  const featuredSet = new Set(featuredPresent);
  const rest = [...new Set(modelIds)].filter((id) => !featuredSet.has(id)).sort((a, b) => a.localeCompare(b));
  return [...featuredPresent, ...rest];
}

/**
 * Lists the models a Vendor currently serves. Returns `{ ok: true, models }` with the
 * live catalogue (featured models first), or `{ ok: false, reason }` with a plain-language
 * reason when the key is rejected (401/403), rate-limited (429), the Vendor errors
 * otherwise, or the Vendor is unreachable. An `AbortError` from the signal is rethrown so
 * the caller can tell a cancellation apart from a failure.
 */
export async function listReasoningModels(input: ListReasoningModelsInput): Promise<ModelListResult> {
  const { vendor, upstreamFetch, signal } = input;
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    return { ok: false, reason: `Add a ${vendor.displayName} key to load its models.` };
  }

  const { url, headers } = vendor.buildListModelsRequest(apiKey);

  let response: Response;
  try {
    response = await upstreamFetch(url, { method: "GET", headers, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    return {
      ok: false,
      reason: `Couldn't reach ${vendor.displayName}. Check your internet connection and try again.`,
    };
  }

  if (!response.ok) {
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
      reason: `${vendor.displayName} couldn't list models (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: `${vendor.displayName} returned an unexpected models response.` };
  }

  const models = orderModels(parseModelIds(payload), vendor.modelShortlist);
  if (models.length === 0) {
    return { ok: false, reason: `${vendor.displayName} returned no models for this key.` };
  }
  return { ok: true, models };
}
