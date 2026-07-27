/**
 * The single shared Reasoning pipeline every Vendor runs (ADR: one request path,
 * Vendors differ only in protocol + stream source). One turn flows:
 *
 *   1. Parse - pull the screenshots out of the Core request.
 *   2. Downscale - shrink each screenshot uniformly via the injected seam.
 *   3. Protocol translation - the Vendor shapes its native upstream request from
 *      the downscaled inputs (Anthropic->OpenAI, or native Anthropic).
 *   4. Stream - POST to the Vendor through the injected `upstreamFetch` boundary.
 *   5. Canonical stream adaptation - reduce the Vendor's SSE to answer-text deltas
 *      and emit canonical events, repairing the Point Tag and remapping its
 *      downscaled coordinates back to real screenshot pixels.
 *
 * Credentials-gating and Vendor selection sit above this, in the Capability; this
 * function assumes the key is present. It throws (rather than yielding an error
 * event) if the Vendor rejects the request, so the caller's `for await` surfaces
 * the failure - matching how the walking skeleton reports upstream failures.
 */
import { adaptTextDeltasToCanonicalStream } from "./canonicalStreamAdapter.js";
import { extractScreenshots } from "./messagePreparation.js";
import { remapForScaleFactor } from "./coordinateRemap.js";
import type { ReasoningVendor } from "./cloudReasoningVendors.js";
import type { CoreChatRequest, CoreChatStreamEvent, DownscaleScreenshot } from "./chatTypes.js";
import type { UpstreamFetch } from "./upstreamFetch.js";

export interface ReasoningPipelineInput {
  /** The Vendor whose protocol and endpoint this turn uses. */
  vendor: ReasoningVendor;
  /** The chat turn to answer. */
  request: CoreChatRequest;
  /** The Model Slot to request, from the routing config. */
  modelSlot: string;
  /** The Vendor's API key (the Capability has already gated on its presence). */
  apiKey: string;
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
  /** Downscales each screenshot before it is sent (production resize; tests stub it). */
  downscaleScreenshot: DownscaleScreenshot;
  /**
   * Aborts the in-flight upstream stream when signalled (Barge-in): the Shell presses
   * the push-to-talk hotkey mid-answer, so the network stream must genuinely cancel -
   * not just stop being read (ticket 11). Forwarded to the `upstreamFetch` boundary so
   * the fetch is aborted at the source, ending this generator's iteration. Absent for
   * an ordinary turn.
   */
  signal?: AbortSignal;
}

export async function* runReasoningPipeline(
  input: ReasoningPipelineInput,
): AsyncGenerator<CoreChatStreamEvent> {
  const { vendor, request, modelSlot, apiKey, upstreamFetch, downscaleScreenshot, signal } = input;

  const screenshots = extractScreenshots(request);
  const downscaledScreenshots = await Promise.all(
    screenshots.map((screenshot) => downscaleScreenshot(screenshot)),
  );

  const upstreamRequest = vendor.buildUpstreamRequest({
    request,
    downscaledScreenshots,
    modelSlot,
    apiKey,
  });

  // Every screenshot shares one uniform downscale factor, so the remap that scales
  // the model's coordinates back up is the inverse of that single factor (the
  // identity when nothing was downscaled).
  const uniformScaleFactor = downscaledScreenshots[0]?.scaleFactor ?? 1;
  const remapCoordinate = remapForScaleFactor(uniformScaleFactor);

  const upstreamResponse = await upstreamFetch(upstreamRequest.url, {
    method: "POST",
    headers: upstreamRequest.headers,
    body: upstreamRequest.body,
    signal,
  });

  if (!upstreamResponse.ok || upstreamResponse.body === null) {
    // Include the Vendor's own error body: it carries the actual reason (bad model
    // id, auth, rate limit) a bare status code would hide.
    const errorBody = await upstreamResponse.text().catch(() => "");
    throw new Error(
      `${vendor.displayName} chat completion failed: HTTP ${upstreamResponse.status}${errorBody ? ` - ${errorBody}` : ""}`,
    );
  }

  const textDeltas = vendor.streamTextDeltas(upstreamResponse.body);
  yield* adaptTextDeltasToCanonicalStream(textDeltas, remapCoordinate);
}
