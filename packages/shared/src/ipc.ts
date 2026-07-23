import { z } from "zod";

/**
 * Bumped whenever the Shell<->Core IPC contract changes shape. The renderer and
 * the Core both stamp/assert this so a version mismatch surfaces immediately
 * rather than as a confusing runtime shape error. The walking skeleton (ticket 02)
 * replaced the placeholder ping round-trip with the streamed chat contract below,
 * so the version advanced to 2. Ticket 05 added the `includeScreen` flag so a turn
 * can ask the Shell to attach screen context, advancing it to 3.
 */
export const LUNE_IPC_VERSION = 3;

/**
 * Fire-and-forget channel the renderer uses to start one chat turn. The reply is
 * a stream, not a single value, so it cannot ride `ipcRenderer.invoke`'s single
 * request/response shape; the Core's streamed events flow back over
 * {@link CHAT_EVENT_CHANNEL} instead, each tagged with the turn's id.
 */
export const CHAT_START_CHANNEL = "lune:chat:start";

/** Channel carrying every streamed event of an in-flight chat turn back to the renderer. */
export const CHAT_EVENT_CHANNEL = "lune:chat:event";

/**
 * One chat turn the renderer sends the Core: an opaque id it mints so it can
 * correlate the streamed events that come back, plus the user's question. The
 * walking skeleton carries text only; screenshots and conversation history join
 * this contract in later tickets.
 */
export const ChatTurnRequestSchema = z.object({
  /** Correlates this request with the {@link ChatStreamEvent}s it produces. */
  turnId: z.string().min(1),
  /** The user's question, typed into the panel. */
  prompt: z.string().min(1),
  /**
   * Whether the Shell should capture the screen(s) and attach them to this turn so
   * the answer is screen-aware (ticket 05). The screenshots themselves never cross
   * this contract - the Shell captures in the main process and hands them to the
   * Core in-process, so sensitive pixels never reach the renderer and are never
   * persisted. Defaults to `true`: a turn is screen-aware unless it opts out (a
   * fully-silent text conversation, or when screen access is not granted).
   */
  includeScreen: z.boolean().default(true),
});
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>;

/**
 * A streamed event of one chat turn, flowing Core -> main -> renderer. The turn
 * opens with exactly one `started` (stamping the contract version so a mismatch
 * surfaces here), then zero or more `delta`s carrying answer text token-by-token,
 * and closes with exactly one terminal event - either `done` on success or `error`
 * if the Core could not produce (or finish) the answer. Every event carries the
 * originating `turnId` so a renderer can ignore events from an abandoned turn.
 */
export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    turnId: z.string().min(1),
    ipcVersion: z.literal(LUNE_IPC_VERSION),
  }),
  z.object({
    type: z.literal("delta"),
    turnId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    turnId: z.string().min(1),
  }),
  z.object({
    type: z.literal("error"),
    turnId: z.string().min(1),
    message: z.string().min(1),
  }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;
