import { z } from "zod";

/**
 * Bumped whenever the Shell<->Core IPC contract changes shape. The renderer and
 * the Core both stamp/assert this so a version mismatch surfaces immediately
 * rather than as a confusing runtime shape error. Ticket 02 replaced the placeholder
 * ping with the streamed chat contract (v2); ticket 05 added the `includeScreen` flag
 * (v3); ticket 06 turned the single-answer stream into a conversation event stream and
 * added the per-turn input method (v4); M5-01 added the Task Agent session contract - the
 * background agent event stream plus its start/cancel commands (v5).
 */
export const LUNE_IPC_VERSION = 5;

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

// ---------------------------------------------------------------------------
// Task Agents (M5-01)
//
// A Task Agent is background work that runs through tools only (DECISIONS #14):
// several run in parallel while the user keeps working, each shown as a card in the
// Agent Stack. Unlike a chat turn (one request -> one stream), the Shell starts and
// cancels agents by command and observes ALL of them over one shared event channel,
// each event tagged with its `sessionId`. The Core owns the runtime; these schemas are
// the wire form the Electron main process maps its native `TaskAgentEvent`s onto.
// ---------------------------------------------------------------------------

/**
 * Command channel (renderer -> main, `invoke`) that starts one Task Agent. Replies with
 * the initial {@link TaskAgentSnapshot} (status `running`) so the Shell can render the
 * card immediately; the agent's progress then arrives over {@link TASK_AGENT_EVENT_CHANNEL}.
 */
export const TASK_AGENT_START_CHANNEL = "lune:taskAgent:start";

/** Command channel (renderer -> main, `invoke`) that cancels a running Task Agent by id. */
export const TASK_AGENT_CANCEL_CHANNEL = "lune:taskAgent:cancel";

/** Channel carrying every streamed event of every in-flight Task Agent back to the renderer. */
export const TASK_AGENT_EVENT_CHANNEL = "lune:taskAgent:event";

/**
 * One Task Agent's lifecycle status. `running` until it settles into exactly one terminal
 * state - `succeeded` (finished with a result), `failed` (errored or hit the step limit),
 * or `cancelled` (the user dismissed it mid-flight).
 */
export const TaskAgentStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export type TaskAgentStatus = z.infer<typeof TaskAgentStatusSchema>;

/**
 * The Shell's request to start a Task Agent: the goal to work toward and, optionally, the
 * Shell's own id for the session (the Core mints one when omitted). Mirrors how a chat
 * turn's id is minted by the renderer so it can correlate the events that come back.
 */
export const StartTaskAgentRequestSchema = z.object({
  /** What the agent should accomplish. */
  goal: z.string().min(1),
  /** The Shell's id for this session; the Core mints one when omitted. */
  sessionId: z.string().min(1).optional(),
});
export type StartTaskAgentRequest = z.infer<typeof StartTaskAgentRequestSchema>;

/** The Shell's request to cancel a running Task Agent. */
export const CancelTaskAgentRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type CancelTaskAgentRequest = z.infer<typeof CancelTaskAgentRequestSchema>;

/**
 * A point-in-time view of one Task Agent - what an Agent Stack card renders. `result` is
 * present only for a `succeeded` session, `error` only for a `failed` one; `step` is a
 * live progress signal (how many model steps have started).
 */
export const TaskAgentSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  goal: z.string(),
  status: TaskAgentStatusSchema,
  step: z.number().int().nonnegative(),
  result: z.string().optional(),
  error: z.string().optional(),
});
export type TaskAgentSnapshot = z.infer<typeof TaskAgentSnapshotSchema>;

/**
 * A streamed event of one Task Agent session, flowing Core -> main -> renderer. A session
 * opens with exactly one `started` (stamping the contract version so a mismatch surfaces
 * here), then repeating `step-started` -> optional `message` -> zero or more
 * (`tool-call` -> `tool-result`) groups, and closes with exactly one of `succeeded` /
 * `failed` / `cancelled`. Every event carries its `sessionId` so one subscription can
 * multiplex all the concurrent agents the Agent Stack shows at once.
 */
export const TaskAgentStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    sessionId: z.string().min(1),
    goal: z.string(),
    ipcVersion: z.literal(LUNE_IPC_VERSION),
  }),
  z.object({
    type: z.literal("step-started"),
    sessionId: z.string().min(1),
    step: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("message"),
    sessionId: z.string().min(1),
    step: z.number().int().positive(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    sessionId: z.string().min(1),
    step: z.number().int().positive(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("tool-result"),
    sessionId: z.string().min(1),
    step: z.number().int().positive(),
    toolCallId: z.string(),
    toolName: z.string(),
    output: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("succeeded"),
    sessionId: z.string().min(1),
    result: z.string(),
  }),
  z.object({
    type: z.literal("failed"),
    sessionId: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal("cancelled"),
    sessionId: z.string().min(1),
  }),
]);
export type TaskAgentStreamEvent = z.infer<typeof TaskAgentStreamEventSchema>;
