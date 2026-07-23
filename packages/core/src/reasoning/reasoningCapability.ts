/**
 * The Core's Reasoning Capability - the public streaming entry point for one chat
 * turn, at full v1 strength: three cloud Vendors behind the Vendor table, selected
 * by the routing config, each credentials-gated on its own key, all running the one
 * shared pipeline.
 *
 * This is the successor of v1's config-driven `capabilityRouter` + cloud Providers,
 * with HTTP removed: the Capability reads the live routing config to pick the
 * Vendor, gates on that Vendor's key (throwing {@link ReasoningNotReadyError}
 * before any upstream call when it is absent), and streams canonical events. The
 * Core owns no transport, no key storage, and no HTTP - the Electron main process
 * injects `fetch`, the per-Vendor keys, and the screenshot downscale; a test injects
 * stubs.
 */
import { findReasoningVendor, type ReasoningVendorId } from "./cloudReasoningVendors.js";
import { runReasoningPipeline } from "./reasoningPipeline.js";
import type { CoreChatRequest, CoreChatStreamEvent, DownscaleScreenshot } from "./chatTypes.js";
import type { RoutingConfig } from "./routingConfig.js";
import type { UpstreamFetch } from "./upstreamFetch.js";

/**
 * Thrown before any upstream call when the routed Vendor has no key. The successor
 * of v1's 503 "not ready" for a credentials-gated cloud Provider, expressed as a
 * typed error now that the Core has no HTTP.
 */
export class ReasoningNotReadyError extends Error {
  constructor(readonly vendorId: ReasoningVendorId, vendorDisplayName: string) {
    super(`${vendorDisplayName} credentials are not configured`);
    this.name = "ReasoningNotReadyError";
  }
}

/** The injected boundaries the Reasoning Capability is built from. */
export interface ReasoningCapabilityDependencies {
  /** The live routing config (which Vendor + Model Slot); re-read on every turn. */
  getRoutingConfig: () => RoutingConfig;
  /**
   * The routed Vendor's API key, read live so a key added after start takes effect
   * without rebuilding the Capability. `undefined` gates that Vendor off.
   */
  getApiKey: (vendorId: ReasoningVendorId) => string | undefined;
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
  /** Downscales each screenshot before it is sent (production resize; tests stub it). */
  downscaleScreenshot: DownscaleScreenshot;
}

/** The Core's Reasoning Capability: a single streaming entry point. */
export interface ReasoningCapability {
  /**
   * Streams one chat turn's answer as canonical events. The Vendor is chosen from
   * the live routing config; switching the config's Vendor/Model Slot changes which
   * upstream is called and with which model. Throws {@link ReasoningNotReadyError}
   * (before any upstream call) when the routed Vendor has no key, and throws if the
   * Vendor rejects the request or the stream cannot be opened.
   */
  streamChat(request: CoreChatRequest): AsyncGenerator<CoreChatStreamEvent>;
}

export function createReasoningCapability(
  dependencies: ReasoningCapabilityDependencies,
): ReasoningCapability {
  const { getRoutingConfig, getApiKey, upstreamFetch, downscaleScreenshot } = dependencies;

  async function* streamChat(request: CoreChatRequest): AsyncGenerator<CoreChatStreamEvent> {
    const { vendor: vendorId, modelSlot } = getRoutingConfig().reasoning;
    const vendor = findReasoningVendor(vendorId);

    const apiKey = getApiKey(vendorId);
    if (apiKey === undefined || apiKey.length === 0) {
      // Credentials-gating: no key -> not ready -> throw without any upstream call.
      throw new ReasoningNotReadyError(vendorId, vendor.displayName);
    }

    yield* runReasoningPipeline({
      vendor,
      request,
      modelSlot,
      apiKey,
      upstreamFetch,
      downscaleScreenshot,
    });
  }

  return { streamChat };
}
