/**
 * The ordinary-model tool-calling boundary a Task Agent runs on (M5-01) - the successor
 * idea of the Reasoning Vendor seam, but for a *non-streamed, tool-calling* turn rather
 * than a streamed answer.
 *
 * The load-bearing product insight (DECISIONS #14) is that a Task Agent needs no
 * computer-use model: an ordinary chat model with tool calling is enough. This seam is
 * where that happens. The runtime owns the vendor-independent conversation
 * ({@link TaskAgentModelMessage}s) and, each step, hands a {@link TaskAgentModelRequest}
 * to a {@link TaskAgentModel}; the model replies with a {@link TaskAgentModelTurn} - the
 * tool calls it wants run, or (no tool calls) its final answer. Each Vendor's native
 * protocol - Anthropic's `tool_use` blocks, the OpenAI-compatible `tool_calls` - lives
 * entirely behind an adapter, so the runtime is one loop for every Vendor and is
 * unit-tested against a stub model with no network.
 *
 * The model is *stateless* over the conversation: the runtime passes the whole message
 * history every step and the adapter translates it, mirroring the Reasoning pipeline
 * (rather than the computer-use adapter's opaque per-session state). A Task Agent Session
 * is bound to one Vendor for its life, so there is no mid-session re-translation to fear.
 */
import type { UpstreamFetch } from "../reasoning/upstreamFetch.js";
import type { ToolSchema } from "./toolTypes.js";

/**
 * The default per-turn token budget for a Task Agent model turn (a tool-call decision or
 * the final spoken summary) - generous for a planning turn, well short of a long essay.
 * Lives on the seam so both adapters share one value rather than each carrying its own.
 */
export const DEFAULT_TASK_AGENT_MODEL_MAX_TOKENS = 1024;

/** One tool call the model requested in a turn. */
export interface TaskAgentToolCall {
  /** The Vendor's id for this call, echoed back on the matching tool result. */
  id: string;
  /** The requested tool's name (resolved against the {@link ToolRegistry}). */
  name: string;
  /** The arguments the model passed, already parsed from the Vendor's wire form. */
  input: Record<string, unknown>;
}

/** The outcome of one tool call, fed back to the model on the next turn. */
export interface TaskAgentToolResult {
  /** The {@link TaskAgentToolCall.id} this result answers. */
  toolCallId: string;
  /** The tool that ran (carried for the OpenAI-compatible wire form and for events). */
  toolName: string;
  /** The tool's output text. */
  output: string;
  /** Whether the tool reported a recoverable failure the model should see and react to. */
  isError: boolean;
}

/**
 * One message of the vendor-independent tool-calling conversation the runtime owns. A
 * Session's history is: the `user` goal, then repeating (`assistant` tool calls ->
 * `tool` results) pairs, until an `assistant` turn with no tool calls ends it.
 */
export type TaskAgentModelMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: readonly TaskAgentToolCall[] }
  | { role: "tool"; results: readonly TaskAgentToolResult[] };

/**
 * The model's reply to one turn: any prose it produced plus the tool calls it wants run.
 * An empty `toolCalls` means the agent is done and `text` is its final spoken summary.
 */
export interface TaskAgentModelTurn {
  text: string;
  toolCalls: TaskAgentToolCall[];
}

/** One tool-calling request the runtime hands the model boundary. */
export interface TaskAgentModelRequest {
  /** The Core-owned canonical Task Agent system prompt. */
  system: string;
  /** The whole conversation so far (the runtime owns and grows it). */
  messages: readonly TaskAgentModelMessage[];
  /** The tools the model may call this turn (the registry's schema projection). */
  tools: readonly ToolSchema[];
  /** The model id to drive (the routing config's Model Slot, or the Vendor default). */
  model: string;
  /** The Vendor's API key (the runtime has already gated on its presence). */
  apiKey: string;
  /** Upper bound on the reply length; the adapter's default is used when absent. */
  maxTokens?: number;
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
  /** Aborts the in-flight upstream call when the Session is cancelled. */
  signal?: AbortSignal;
}

/**
 * The ordinary-model tool-calling boundary the runtime drives. Injected, so the runtime
 * is tested against a stub and production wires the per-Vendor adapters
 * (`anthropicTaskAgentModel`, `openAiTaskAgentModel`).
 */
export interface TaskAgentModel {
  /**
   * Runs one tool-calling turn and returns the model's reply. Throws
   * {@link TaskAgentModelUpstreamError} on a not-OK Vendor response so the runtime can
   * fail the Session cleanly; an aborted call rejects (the runtime reads that as a
   * cancellation, not a failure).
   */
  generate(request: TaskAgentModelRequest): Promise<TaskAgentModelTurn>;
}

/**
 * A Vendor's tool-calling turn came back not-OK. Mirrors the computer-use path's
 * upstream error: it carries the HTTP `status` and the Vendor's raw error `body`
 * separately (not just baked into the message) so the Shell can classify the failure - a
 * 429 quota, a 401/403 auth, a 404 model-access, a 5xx - and explain it in plain words.
 */
export class TaskAgentModelUpstreamError extends Error {
  constructor(
    /** The Vendor's human-readable name (for the spoken/rendered explanation). */
    readonly vendorDisplayName: string,
    /** The HTTP status the Vendor returned (e.g. 429 for quota exhausted). */
    readonly status: number,
    /** The Vendor's raw error body, carrying the actual reason (kept for logs/diagnostics). */
    readonly body: string,
  ) {
    super(
      `${vendorDisplayName} tool-calling request failed: HTTP ${status}${body ? ` - ${body}` : ""}`,
    );
    this.name = "TaskAgentModelUpstreamError";
  }
}

/**
 * Throws a {@link TaskAgentModelUpstreamError} when a Vendor's tool-calling response is
 * not OK, so every adapter fails identically and the runtime ends the Session with a
 * readable reason (the status plus the Vendor's own error body).
 */
export async function throwIfModelResponseNotOk(
  response: Response,
  vendorDisplayName: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const errorBody = await response.text().catch(() => "");
  throw new TaskAgentModelUpstreamError(vendorDisplayName, response.status, errorBody);
}
