import { z } from "zod";

/**
 * Bumped whenever the Shell<->Core IPC contract changes shape. The renderer and
 * the Core both stamp/assert this so a version mismatch surfaces immediately
 * rather than as a confusing runtime shape error.
 */
export const LUNE_IPC_VERSION = 1;

/** IPC channel name for the placeholder ping round-trip. */
export const PING_IPC_CHANNEL = "lune:ping";

/**
 * The placeholder request the renderer sends the Core to prove the typed IPC
 * boundary is wired end to end. Ticket 02 (the walking skeleton) replaces this
 * with the real chat round-trip; for now it carries only a send timestamp so the
 * response can echo it back.
 */
export const PingRequestSchema = z.object({
  sentFromShellAtEpochMs: z.number().int().nonnegative(),
});
export type PingRequest = z.infer<typeof PingRequestSchema>;

/**
 * The Core's reply to a {@link PingRequest}: the contract version it validated
 * against, a human-readable Core identifier, and the echoed send timestamp.
 */
export const PingResponseSchema = z.object({
  ipcVersion: z.literal(LUNE_IPC_VERSION),
  coreDescription: z.string().min(1),
  receivedByCoreAtEpochMs: z.number().int().nonnegative(),
});
export type PingResponse = z.infer<typeof PingResponseSchema>;
