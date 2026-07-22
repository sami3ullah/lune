import {
  LUNE_IPC_VERSION,
  PingResponseSchema,
  type PingRequest,
  type PingResponse,
} from "@lune/shared";

// @lune/core is the pure, transport-agnostic TypeScript package that owns all of
// Lune's intelligence (developer story 45). It imports no Electron and no HTTP:
// the Electron main process (or, later, a thin HTTP adapter) is what bridges these
// plain typed functions to a Shell. This scaffold ships a single placeholder
// function proving the shared contract flows through; the real Capabilities
// (chat, transcribe, speech, provisioning, status, config) are ported in later
// tickets.

/**
 * Human-readable identifier for this Core build. The Shell surfaces it so we can
 * confirm the Shell<->Core wiring is live before any real Capability exists.
 */
export function describeCore(): string {
  return `Lune Core (IPC v${LUNE_IPC_VERSION})`;
}

/**
 * Placeholder request handler: consumes a shared-contract request and returns a
 * validated shared-contract response, entirely in-process. Ticket 02 replaces
 * this with the streamed Gemini reply.
 */
export function handlePing(pingRequest: PingRequest): PingResponse {
  return PingResponseSchema.parse({
    ipcVersion: LUNE_IPC_VERSION,
    coreDescription: describeCore(),
    receivedByCoreAtEpochMs: pingRequest.sentFromShellAtEpochMs,
  });
}
