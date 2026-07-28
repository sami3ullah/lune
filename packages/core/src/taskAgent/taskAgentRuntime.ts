/**
 * The Task Agent runtime (M5-01): the ordinary-model tool-calling engine at the heart of
 * the Task Agent epic.
 *
 * A Task Agent works through tools only and runs in the background, so - unlike the
 * Screen Agent, whose loop the Shell steps one screenshot at a time - this runtime owns
 * its own loop. `start` returns immediately with a handle and the loop runs detached:
 * each step it asks the routed Vendor's {@link TaskAgentModel} what to do next, executes
 * the tool calls it requests against the {@link ToolRegistry}, feeds the results back,
 * and repeats until the model finishes with an answer (or a limit/error/cancel ends it).
 *
 * Several Sessions run at once with fully independent lifecycles: each has its own
 * conversation, its own {@link AbortController}, and its own snapshot, so cancelling or
 * failing one never touches another (the concurrency the Agent Stack is built on). Work
 * is observable live: every Session multiplexes its {@link TaskAgentEvent}s onto one
 * `subscribe` stream, and `get`/`list` return current snapshots for late subscribers.
 *
 * Boundaries stay clean, like every other Capability: the Core holds the loop, the
 * conversation, and the Vendor call (through the injected `upstreamFetch`); it touches no
 * OS and no transport. The tools' actual effects (M5-02) live behind the registry's
 * `execute`, and the Shell's Agent Stack (M5-03) is a pure consumer of this seam. This
 * module imports no HTTP and no Electron.
 */
import { findReasoningVendor, type ReasoningVendorId } from "../reasoning/cloudReasoningVendors.js";
import type { RoutingConfig } from "../reasoning/routingConfig.js";
import type { UpstreamFetch } from "../reasoning/upstreamFetch.js";
import { TASK_AGENT_SYSTEM_PROMPT } from "./taskAgentSystemPrompt.js";
import type {
  TaskAgentModel,
  TaskAgentModelMessage,
  TaskAgentToolResult,
} from "./taskAgentModel.js";
import type { ToolRegistry } from "./toolRegistry.js";
import type { ToolArtifact } from "./toolTypes.js";
import type { TaskAgentEvent, TaskAgentSnapshot } from "./taskAgentTypes.js";

/**
 * The default cap on model steps for one Session - a backstop against a model that loops
 * on tools without ever finishing. Generous enough that a real multi-tool task never
 * reaches it; hitting it fails the Session with a readable reason rather than running
 * forever.
 */
export const DEFAULT_TASK_AGENT_MAX_STEPS = 24;

/**
 * Thrown by `start` (synchronously, before a Session is created) when the routed Vendor
 * cannot run a Task Agent: no adapter is wired for it, or its key is absent. Mirrors
 * {@link import("../reasoning/reasoningCapability.js").ReasoningNotReadyError} - a not-ready
 * routed Vendor surfaces as "background work isn't available" rather than a dead card.
 */
export class TaskAgentNotReadyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TaskAgentNotReadyError";
  }
}

/** Thrown by `start` when the request is malformed (an empty goal, a duplicate id). */
export class TaskAgentStartInputError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TaskAgentStartInputError";
  }
}

/** The injected boundaries the Task Agent runtime is built from. */
export interface TaskAgentRuntimeDependencies {
  /** Reads the live routing config so the routed Vendor is resolved when a Session starts. */
  getRoutingConfig: () => RoutingConfig;
  /**
   * The wired tool-calling adapters, keyed by Vendor id. All three ordinary Reasoning
   * Vendors support tool calling, so any of them can run a Task Agent; a missing entry
   * means that Vendor's adapter is not wired (not ready).
   */
  models: Partial<Record<ReasoningVendorId, TaskAgentModel>>;
  /**
   * The routed Vendor's API key, read live so a key added after construction takes effect.
   * `undefined` gates that Vendor off (not ready).
   */
  getApiKey: (vendorId: ReasoningVendorId) => string | undefined;
  /** The tools a Task Agent may call (stubbed in tests; the real local set in M5-02). */
  tools: ToolRegistry;
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
  /** Mints a Session id when the caller doesn't supply one (injected for deterministic tests). */
  generateSessionId?: () => string;
  /** Overrides the canonical Task Agent system prompt (defaults to {@link TASK_AGENT_SYSTEM_PROMPT}). */
  systemPrompt?: string;
  /** Overrides the per-Session step cap (defaults to {@link DEFAULT_TASK_AGENT_MAX_STEPS}). */
  maxSteps?: number;
}

/** One Session to start: the goal to work toward, and optionally the Shell's own id for it. */
export interface StartTaskAgentInput {
  /** What the Session should accomplish. */
  goal: string;
  /** The Shell's id for this Session; a fresh one is minted when omitted. */
  sessionId?: string;
}

/** The handle `start` returns: the Session's id, its initial snapshot, and its completion. */
export interface TaskAgentHandle {
  sessionId: string;
  /** The Session's snapshot at the instant `start` returned (status `running`, step 0). */
  snapshot: TaskAgentSnapshot;
  /**
   * Resolves with the terminal snapshot when the Session settles. It never rejects - a
   * failure is a terminal `failed` snapshot, matching the background, event-driven model
   * (the Shell renders the card, it doesn't catch an exception). Mostly for tests and any
   * caller that wants to await one Session; the Shell drives off `subscribe` instead.
   */
  completion: Promise<TaskAgentSnapshot>;
}

/** A subscriber notified of every {@link TaskAgentEvent} across all Sessions. */
export type TaskAgentListener = (event: TaskAgentEvent) => void;

/** The Task Agent runtime: start, observe, and cancel background tool-calling Sessions. */
export interface TaskAgentRuntime {
  /**
   * Starts a Session and returns immediately; its loop runs detached. Throws
   * {@link TaskAgentNotReadyError} (before creating the Session) when the routed Vendor
   * has no wired adapter or key, and {@link TaskAgentStartInputError} on a bad request.
   */
  start(input: StartTaskAgentInput): TaskAgentHandle;
  /**
   * Requests cancellation of a running Session. Returns `true` if it was running (its
   * loop will settle `cancelled` at its next checkpoint), `false` if unknown or already
   * terminal. Cancelling one Session never affects another.
   */
  cancel(sessionId: string): boolean;
  /** The current snapshot of one Session, or `undefined` if unknown. */
  get(sessionId: string): TaskAgentSnapshot | undefined;
  /** A snapshot of every Session the runtime has seen, in start order. */
  list(): TaskAgentSnapshot[];
  /** Subscribes to the event stream of all Sessions; returns an unsubscribe function. */
  subscribe(listener: TaskAgentListener): () => void;
}

/** One Session's live in-process state. */
interface RunningSession {
  /** The mutable snapshot the runtime advances and hands out defensive copies of. */
  snapshot: TaskAgentSnapshot;
  /** Aborts this Session's in-flight model call and tool, without touching others. */
  controller: AbortController;
}

export function createTaskAgentRuntime(
  dependencies: TaskAgentRuntimeDependencies,
): TaskAgentRuntime {
  const {
    getRoutingConfig,
    models,
    getApiKey,
    tools,
    upstreamFetch,
    systemPrompt = TASK_AGENT_SYSTEM_PROMPT,
    maxSteps = DEFAULT_TASK_AGENT_MAX_STEPS,
  } = dependencies;

  // A monotonic fallback id source, so a Shell that doesn't supply ids still gets unique
  // ones without pulling in a randomness/clock dependency the Core avoids.
  let sessionCounter = 0;
  const generateSessionId =
    dependencies.generateSessionId ?? (() => `task-agent-${(sessionCounter += 1)}`);

  const sessions = new Map<string, RunningSession>();
  const listeners = new Set<TaskAgentListener>();

  /** Notifies every subscriber; snapshot copied out so a listener can't mutate a live one. */
  function publish(event: TaskAgentEvent): void {
    // Copy the listener set so a subscriber unsubscribing (or subscribing) during dispatch
    // doesn't disturb this iteration.
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  /** The routed Vendor, its wired adapter, key, and model id - resolved once per Session. */
  interface ResolvedRoute {
    model: TaskAgentModel;
    modelId: string;
    apiKey: string;
  }

  function resolveRoute(): ResolvedRoute {
    const selection = getRoutingConfig().reasoning;
    const model = models[selection.vendor];
    if (model === undefined) {
      throw new TaskAgentNotReadyError(
        `No Task Agent model is wired for the '${selection.vendor}' Reasoning vendor`,
      );
    }
    const apiKey = getApiKey(selection.vendor);
    if (apiKey === undefined || apiKey.length === 0) {
      throw new TaskAgentNotReadyError(
        `${findReasoningVendor(selection.vendor).displayName} credentials are not configured`,
      );
    }
    const trimmedSlot = selection.modelSlot.trim();
    const modelId = trimmedSlot.length > 0 ? trimmedSlot : findReasoningVendor(selection.vendor).defaultModel;
    return { model, modelId, apiKey };
  }

  function start(input: StartTaskAgentInput): TaskAgentHandle {
    const goal = input.goal.trim();
    if (goal.length === 0) {
      throw new TaskAgentStartInputError("A Task Agent Session requires a goal");
    }

    // Resolve (and gate on) the routed Vendor before the Session exists, so a not-ready
    // Vendor throws rather than producing a card that instantly fails. The route is bound
    // for the Session's life: re-routing Reasoning mid-flight doesn't switch a running agent.
    const route = resolveRoute();

    const sessionId = (input.sessionId ?? generateSessionId()).trim();
    if (sessionId.length === 0) {
      throw new TaskAgentStartInputError("A Task Agent Session id cannot be blank");
    }
    if (sessions.has(sessionId)) {
      throw new TaskAgentStartInputError(`A Task Agent Session already exists for id '${sessionId}'`);
    }

    const snapshot: TaskAgentSnapshot = { sessionId, goal, status: "running", step: 0 };
    const session: RunningSession = { snapshot, controller: new AbortController() };
    sessions.set(sessionId, session);

    // Take the pristine (running, step 0) snapshot before the detached loop can advance it.
    const initialSnapshot: TaskAgentSnapshot = { ...snapshot };

    // Defer the loop to a microtask so `start` fully returns its handle first - the caller
    // (and any test) can rely on seeing every event, including `started`, after start().
    const completion = Promise.resolve().then(() => runSession(session, route));

    return { sessionId, snapshot: initialSnapshot, completion };
  }

  /** Runs one Session's loop to a terminal state and returns its final snapshot. */
  async function runSession(
    session: RunningSession,
    route: ResolvedRoute,
  ): Promise<TaskAgentSnapshot> {
    const { snapshot } = session;
    const { signal } = session.controller;

    publish({ type: "started", sessionId: snapshot.sessionId, goal: snapshot.goal });

    const messages: TaskAgentModelMessage[] = [{ role: "user", text: snapshot.goal }];
    // The latest concrete artifact any tool produced (a written file, an opened URL). Carried
    // onto the terminal success so the card can offer a reliable "Open it" - last one wins,
    // since the final file the agent writes is the natural thing to open.
    let latestArtifact: ToolArtifact | undefined;

    while (true) {
      if (signal.aborted) {
        return settle(session, { status: "cancelled" });
      }
      if (snapshot.step >= maxSteps) {
        return settle(session, {
          status: "failed",
          error: `Task Agent stopped after reaching the ${maxSteps}-step limit`,
        });
      }

      snapshot.step += 1;
      publish({ type: "step-started", sessionId: snapshot.sessionId, step: snapshot.step });

      let turn;
      try {
        turn = await route.model.generate({
          system: systemPrompt,
          // A snapshot of the conversation as of this step: the runtime keeps growing the
          // live array, so an adapter that holds onto the request must never see later turns.
          messages: [...messages],
          tools: tools.schemas(),
          model: route.modelId,
          apiKey: route.apiKey,
          upstreamFetch,
          signal,
        });
      } catch (modelError) {
        // An aborted upstream call is a cancellation, not a failure; a genuine error fails.
        if (signal.aborted) {
          return settle(session, { status: "cancelled" });
        }
        return settle(session, { status: "failed", error: errorMessage(modelError) });
      }
      if (signal.aborted) {
        return settle(session, { status: "cancelled" });
      }

      const spokenText = turn.text.trim();
      if (spokenText.length > 0) {
        publish({ type: "message", sessionId: snapshot.sessionId, step: snapshot.step, text: spokenText });
      }
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

      if (turn.toolCalls.length === 0) {
        // No tool calls: the model is done and its text is the spoken result.
        return settle(session, { status: "succeeded", result: spokenText, artifact: latestArtifact });
      }

      // Execute the requested tool calls in order, feeding each result back to the model.
      // Sequential (not parallel) so the ordering is deterministic and M5-02's Confirm
      // Gate can interpose one call at a time.
      const results: TaskAgentToolResult[] = [];
      for (const toolCall of turn.toolCalls) {
        if (signal.aborted) {
          return settle(session, { status: "cancelled" });
        }
        publish({
          type: "tool-call",
          sessionId: snapshot.sessionId,
          step: snapshot.step,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
        });

        const result = await executeToolCall(toolCall.name, toolCall.input, snapshot.sessionId, signal);
        if (signal.aborted) {
          // Cancelled mid-tool: drop this result and settle rather than feeding it back.
          return settle(session, { status: "cancelled" });
        }
        // Remember the newest openable thing a successful call produced (last wins).
        if (result.artifact !== undefined && result.isError !== true) {
          latestArtifact = result.artifact;
        }

        publish({
          type: "tool-result",
          sessionId: snapshot.sessionId,
          step: snapshot.step,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          output: result.output,
          isError: result.isError,
        });
        results.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          output: result.output,
          isError: result.isError,
        });
      }

      messages.push({ role: "tool", results });
    }
  }

  /**
   * Runs one tool call, never throwing: an unknown tool or a thrown tool becomes a
   * recoverable error result the model sees and can react to, so a single bad call can't
   * crash the whole Session. (A cancellation is handled by the caller via the signal.)
   */
  async function executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ output: string; isError: boolean; artifact?: ToolArtifact }> {
    const tool = tools.get(toolName);
    if (tool === undefined) {
      return { output: `Unknown tool: '${toolName}'`, isError: true };
    }
    try {
      const result = await tool.execute(input, { sessionId, signal });
      return { output: result.output, isError: result.isError ?? false, artifact: result.artifact };
    } catch (toolError) {
      return { output: errorMessage(toolError), isError: true };
    }
  }

  /** Moves a Session to its one terminal state, emits the matching event, and returns the snapshot. */
  function settle(
    session: RunningSession,
    outcome:
      | { status: "succeeded"; result?: string; artifact?: ToolArtifact }
      | { status: "failed"; error: string }
      | { status: "cancelled" },
  ): TaskAgentSnapshot {
    const { snapshot } = session;
    // Guard against a double-settle (e.g. an abort racing the model's natural finish):
    // the first terminal state wins and is final.
    if (snapshot.status === "running") {
      snapshot.status = outcome.status;
      if (outcome.status === "succeeded") {
        snapshot.result = outcome.result ?? "";
        snapshot.artifact = outcome.artifact;
        publish({ type: "succeeded", sessionId: snapshot.sessionId, result: snapshot.result, artifact: outcome.artifact });
      } else if (outcome.status === "failed") {
        snapshot.error = outcome.error;
        publish({ type: "failed", sessionId: snapshot.sessionId, message: snapshot.error });
      } else {
        publish({ type: "cancelled", sessionId: snapshot.sessionId });
      }
    }
    return { ...snapshot };
  }

  function cancel(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (session === undefined || session.snapshot.status !== "running") {
      return false;
    }
    // Signal the loop; it settles `cancelled` at its next checkpoint (or when the aborted
    // upstream call rejects). The terminal snapshot is written there, not here, so there
    // is one settle path.
    session.controller.abort();
    return true;
  }

  return {
    start,
    cancel,
    get: (sessionId) => {
      const session = sessions.get(sessionId);
      return session === undefined ? undefined : { ...session.snapshot };
    },
    list: () => [...sessions.values()].map((session) => ({ ...session.snapshot })),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The readable message of a thrown value (Error or otherwise), for a failed snapshot. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
