/**
 * The Task Agent Session model (M5-01): the lifecycle status and terminal result the
 * Agent Stack renders, and the events streamed to the Shell as work happens.
 *
 * These are the Core's native shapes - not any one surface's view model and not the IPC
 * wire form. The Agent Stack (M5-03) renders a card per Session from a
 * {@link TaskAgentSnapshot}, and updates it live from the {@link TaskAgentEvent} stream;
 * the Electron main process maps these onto the typed IPC contract in `@lune/shared`,
 * exactly as it maps `CoreConversationEvent` onto the conversation IPC events.
 */

import type { ToolArtifact } from "./toolTypes.js";

export type { ToolArtifact };

/**
 * One Task Agent Session's lifecycle status. A Session is `running` until it reaches
 * exactly one terminal state: `succeeded` (the model finished with a result), `failed`
 * (the model or a tool errored unrecoverably, or the step limit was hit), or `cancelled`
 * (the user dismissed it mid-flight). Terminal states are final.
 */
export type TaskAgentStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * A point-in-time view of one Session - what the Agent Stack shows on a card. `result`
 * is set only when `status` is `succeeded`; `error` only when `status` is `failed`.
 */
export interface TaskAgentSnapshot {
  /** Identifies the Session across events, cancellation, and lookups. */
  sessionId: string;
  /** The goal the Session is working toward (what the card labels itself with). */
  goal: string;
  /** The Session's current lifecycle status. */
  status: TaskAgentStatus;
  /** How many model steps have started so far (a live progress signal). */
  step: number;
  /** The final spoken summary, present only when `status` is `succeeded`. */
  result?: string;
  /**
   * The concrete thing the agent produced (a written file, an opened URL) that the card can
   * offer to open. Present only when `status` is `succeeded` and the run produced one - the
   * session's latest tool artifact.
   */
  artifact?: ToolArtifact;
  /** The readable failure reason, present only when `status` is `failed`. */
  error?: string;
}

/**
 * One streamed event of a Task Agent Session, in the Core's native shape. A Session
 * emits exactly one `started`, then repeating `step-started` -> optional `message` ->
 * zero or more (`tool-call` -> `tool-result`) groups, and closes with exactly one of
 * `succeeded` / `failed` / `cancelled`. Unlike the Reasoning stream, a Task Agent never
 * throws its terminal outcome - it runs in the background, so a failure is a `failed`
 * event on the stream (a readable card), not an exception the caller must catch.
 *
 * Every event carries its `sessionId` so a single subscription can multiplex all the
 * concurrent Sessions the Agent Stack shows at once.
 */
export type TaskAgentEvent =
  | { type: "started"; sessionId: string; goal: string }
  | { type: "step-started"; sessionId: string; step: number }
  | { type: "message"; sessionId: string; step: number; text: string }
  | {
      type: "tool-call";
      sessionId: string;
      step: number;
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool-result";
      sessionId: string;
      step: number;
      toolCallId: string;
      toolName: string;
      output: string;
      isError: boolean;
    }
  | { type: "succeeded"; sessionId: string; result: string; artifact?: ToolArtifact }
  | { type: "failed"; sessionId: string; message: string }
  | { type: "cancelled"; sessionId: string };
