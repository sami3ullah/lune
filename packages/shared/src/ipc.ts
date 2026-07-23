import { z } from "zod";

/**
 * Bumped whenever the Shell<->Core IPC contract changes shape. The renderer and
 * the Core both stamp/assert this so a version mismatch surfaces immediately
 * rather than as a confusing runtime shape error. Ticket 02 replaced the placeholder
 * ping with the streamed chat contract (v2); ticket 05 added the `includeScreen` flag
 * (v3); ticket 06 turned the single-answer stream into a conversation event stream and
 * added the per-turn input method (v4).
 */
export const LUNE_IPC_VERSION = 4;

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
 * How the user provided a turn's input. Text is the only method in M1; voice arrives
 * with the push-to-talk loop (ticket 11) and lands in the same conversation history,
 * so the field exists now to keep that a value change, not a schema change.
 */
export const ChatInputMethodSchema = z.enum(["text", "voice"]);
export type ChatInputMethod = z.infer<typeof ChatInputMethodSchema>;

/**
 * One chat turn the renderer sends the Core: an opaque id it mints so it can
 * correlate the streamed events that come back, the user's question, how it was
 * entered, and whether to attach screen context (ticket 05). The screenshots
 * themselves never cross this contract - the Shell captures them in the main process.
 */
export const ChatTurnRequestSchema = z.object({
  /** Correlates this request with the {@link ConversationStreamEvent}s it produces. */
  turnId: z.string().min(1),
  /** The user's question. */
  prompt: z.string().min(1),
  /** How the user entered this turn; defaults to text (voice arrives in ticket 11). */
  inputMethod: ChatInputMethodSchema.default("text"),
  /** Whether the Shell should attach the screen(s) to this turn. Defaults to on. */
  includeScreen: z.boolean().default(true),
});
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>;

/**
 * A streamed event of one conversation turn, flowing Core -> main -> renderer. The
 * turn opens with exactly one `started` (stamping the contract version so a mismatch
 * surfaces here), then one `user-message` (the Core appended the user's turn - this is
 * what the panel renders, so voice and text turns render identically), then one
 * `assistant-started`, then zero or more `assistant-delta`s carrying the reply
 * token-by-token, and closes with either `assistant-completed` on success or `error`
 * if the turn could not be produced (or finished). Every event carries the originating
 * `turnId` so a renderer can ignore events from an abandoned turn, and the assistant
 * events carry the `messageId` of the reply they build.
 */
export const ConversationStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    turnId: z.string().min(1),
    ipcVersion: z.literal(LUNE_IPC_VERSION),
  }),
  z.object({
    type: z.literal("user-message"),
    turnId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string(),
    inputMethod: ChatInputMethodSchema,
  }),
  z.object({
    type: z.literal("assistant-started"),
    turnId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.object({
    type: z.literal("assistant-delta"),
    turnId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("assistant-completed"),
    turnId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.object({
    type: z.literal("error"),
    turnId: z.string().min(1),
    message: z.string().min(1),
  }),
]);
export type ConversationStreamEvent = z.infer<typeof ConversationStreamEventSchema>;
