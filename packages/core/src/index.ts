import { LUNE_IPC_VERSION } from "@lune/shared";

// @lune/core is the pure, transport-agnostic TypeScript package that owns all of
// Lune's intelligence (developer story 45). It imports no Electron and no HTTP:
// the Electron main process (or, later, a thin HTTP adapter) is what bridges these
// plain typed functions/streams to a Shell. The walking skeleton (ticket 02) ports
// the minimum-width Reasoning slice - a Gemini-only streamed `chat` behind the
// injected upstream-fetch seam; the remaining Capabilities (transcribe, speech,
// provisioning, status, config) and Vendors are ported in later tickets.

export {
  createChatCapability,
  ChatNotReadyError,
  type ChatCapability,
  type ChatCapabilityDependencies,
  type CoreChatRequest,
  type CoreChatStreamEvent,
} from "./reasoning/chatCapability.js";
export { GEMINI_VENDOR, type CloudReasoningVendor } from "./reasoning/geminiVendor.js";
export type { UpstreamFetch } from "./reasoning/upstreamFetch.js";

/**
 * Human-readable identifier for this Core build, stamped with the IPC contract
 * version it was compiled against. The Shell surfaces it so the Shell<->Core
 * wiring (and version agreement) can be confirmed at a glance.
 */
export function describeCore(): string {
  return `Lune Core (IPC v${LUNE_IPC_VERSION})`;
}
