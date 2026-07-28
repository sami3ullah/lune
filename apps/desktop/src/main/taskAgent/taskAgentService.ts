import {
  createLocalToolSet,
  createToolRegistry,
  type LocalToolPlatform,
  type ToolConfirmGate,
  type ToolRegistry,
  type TaskAgentRuntime,
} from "@lune/core";

// The Shell-side composition of the Task Agent's local tool set (M5-02) and the env-gated
// dev trigger that demonstrates it end to end - mirroring the Screen Agent's
// `screenAgentService` + `runScreenAgentDevTrigger`. The Core owns the runtime, the tool
// schemas, and the safety classification; this assembles the runtime's tool registry from
// the real Node platform + the voice Confirm Gate, and drives one session from an env var
// until the automatic agent routing (M5-04) and the Agent Stack surface (M5-03) land.

/** The pieces the Task Agent's local tool registry is built from. */
export interface TaskAgentToolRegistryDependencies {
  /** The Node/Electron OS/network effects boundary (`createNodeLocalToolPlatform`). */
  platform: LocalToolPlatform;
  /** The voice Confirm Gate a consequential call must pass (`createToolConfirmGateController`). */
  confirm: ToolConfirmGate;
  /** Overrides the shell-command allowlist; defaults to the Core's read-only default set. */
  safeShellCommands?: readonly string[];
}

/**
 * Builds the tool registry the Task Agent runtime calls: the whole local tool set, with its
 * effects bound to the Node platform and its dangerous calls gated by the voice Confirm
 * Gate. Handed straight to {@link import("@lune/core").createTaskAgentRuntime}'s `tools`.
 */
export function createTaskAgentToolRegistry(
  dependencies: TaskAgentToolRegistryDependencies,
): ToolRegistry {
  return createToolRegistry(
    createLocalToolSet({
      platform: dependencies.platform,
      confirm: dependencies.confirm,
      safeShellCommands: dependencies.safeShellCommands,
    }),
  );
}

/** The env var whose value (a spoken-style goal) runs the Task Agent dev trigger; absent = no-op. */
const TASK_AGENT_DEV_ENV = "LUNE_TASK_AGENT_DEV";

/** Options for {@link runTaskAgentDevTrigger}. */
export interface TaskAgentDevTriggerOptions {
  /** Where progress/outcome lines go; defaults to the console. */
  log?: (message: string) => void;
  /**
   * Registers the run's abort handle so a push-to-talk press cancels the Session (Barge-in),
   * exactly as the Screen Agent dev trigger does. Paired with {@link unregisterBargeIn}.
   */
  registerBargeIn?: (abort: AbortController) => void;
  /** Unregisters the run's abort handle once the run ends. */
  unregisterBargeIn?: (abort: AbortController) => void;
}

/**
 * The env-gated dev trigger (on `LUNE_TASK_AGENT_DEV`) that runs one Task Agent Session from
 * the env var's value as the goal, before the automatic agent routing (M5-04) exists. It
 * demonstrates the acceptance flows end to end - "play X on Spotify" (AppleScript), "open
 * this site" (open_url), "write me a note file" (write_file), and a destructive-vs-allowlisted
 * shell command tripping (or skipping) the voice Confirm Gate - and cancellation via the
 * registered Barge-in handle. A no-op when the env var is absent, so a normal launch does
 * nothing.
 *
 * @returns whether a run was actually started.
 */
export async function runTaskAgentDevTrigger(
  runtime: TaskAgentRuntime,
  options: TaskAgentDevTriggerOptions = {},
): Promise<boolean> {
  const log = options.log ?? ((message: string) => console.log(`[lune] ${message}`));
  const goal = process.env[TASK_AGENT_DEV_ENV]?.trim();
  if (goal === undefined || goal.length === 0) {
    return false;
  }

  const abort = new AbortController();
  options.registerBargeIn?.(abort);

  // Log the live event trace for the one Session we start, so the tool plan is visible.
  let sessionId: string | null = null;
  const unsubscribe = runtime.subscribe((event) => {
    if (sessionId !== null && event.sessionId !== sessionId) {
      return;
    }
    if (event.type === "tool-call") {
      log(`task agent: calling ${event.toolName}(${JSON.stringify(event.input)})`);
    } else if (event.type === "tool-result") {
      log(`task agent: ${event.toolName} -> ${event.isError ? "error: " : ""}${event.output}`);
    } else if (event.type === "message") {
      log(`task agent says: ${event.text}`);
    }
  });

  try {
    let handle;
    try {
      handle = runtime.start({ goal });
    } catch (error) {
      // A not-ready Vendor (no key / no adapter) or a bad goal: degrade to a clean line.
      log(`task agent dev trigger: could not start - ${errorMessage(error)}`);
      return true;
    }
    sessionId = handle.sessionId;
    // Barge-in: a push-to-talk press cancels this Session (the runtime settles it cancelled).
    abort.signal.addEventListener("abort", () => runtime.cancel(handle.sessionId));

    log(`task agent dev trigger: starting a session for goal "${goal}"`);
    const snapshot = await handle.completion;
    const tail =
      snapshot.result !== undefined
        ? ` - "${snapshot.result}"`
        : snapshot.error !== undefined
          ? ` - ${snapshot.error}`
          : "";
    log(`task agent dev trigger: session ${snapshot.status} after ${snapshot.step} step(s)${tail}`);
  } finally {
    unsubscribe();
    options.unregisterBargeIn?.(abort);
  }
  return true;
}

/** The readable message of a thrown value (Error or otherwise). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
