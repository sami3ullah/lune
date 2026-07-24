// The Screen Agent's session guardrails (M2-03): the v1 safety net that guarantees a
// bounded run no matter what the computer-use model does. Three independent limits, each
// of which on its own must be able to terminate a runaway session (acceptance #3):
//
//   - step cap: a hard ceiling on the number of Actions the loop will execute;
//   - wall-clock timeout: a hard ceiling on the session's elapsed duration;
//   - no-progress detector: a screen fingerprint that trips when the scene stops changing
//     for too many consecutive Steps (the model stuck clicking a dead spot, or looping
//     `observe` forever with nothing happening).
//
// It is pure over its inputs - the step count, the elapsed time, and each scene's
// fingerprint - so every limit is unit-testable against fakes without a real loop, clock,
// or screen. The loop (`screenAgentLoop`) owns the cadence and the OS edges and simply
// asks this before each Step whether the run may continue; the guardrails hold only the
// small amount of state the no-progress detector needs (the last fingerprint + its run
// length), kept per session by constructing a fresh instance per run.

/** The three limits that bound a Screen Agent session; each is enforced independently. */
export interface ScreenAgentGuardrailConfig {
  /** The most Actions a session may execute before it is stopped. */
  maxSteps: number;
  /** The longest a session may run, in milliseconds, before it is stopped. */
  maxWallClockMs: number;
  /**
   * How many times in a row an identical scene fingerprint may be *observed* before the
   * no-progress detector trips (occurrences counted, the first included). `3` means the
   * third identical scene in a row stops the run - a changing screen resets the count.
   * `0` disables the detector (nothing ever trips it), leaving the run bounded by the step
   * cap and timeout alone.
   */
  maxRepeatedScreens: number;
}

/**
 * The default guardrails, carried from v1's Screen Agent: generous enough for a real
 * multi-step GUI task (open an app, navigate, toggle a setting) yet tight enough that a
 * model gone haywire is stopped in seconds-to-minutes, not indefinitely.
 */
export const DEFAULT_SCREEN_AGENT_GUARDRAILS: ScreenAgentGuardrailConfig = {
  maxSteps: 40,
  maxWallClockMs: 3 * 60 * 1000,
  maxRepeatedScreens: 4,
};

/** Which guardrail stopped a session. Distinct so the Shell can explain the stop honestly. */
export type GuardrailStopReason = "step-cap" | "timeout" | "no-progress";

/** The budget a Step is measured against: how many Actions have run, and for how long. */
export interface GuardrailBudget {
  /** How many Actions have been executed against the OS so far this Session. */
  stepCount: number;
  /** How long the Session has run, in milliseconds. */
  elapsedMs: number;
}

/** The session guardrails: ask before each Step whether the run may continue. */
export interface ScreenAgentGuardrails {
  /**
   * Checks the budget limits (step cap + wall-clock) before the loop decides/executes the
   * next Step. Returns the guardrail that has been exceeded, or `null` to continue. The
   * step cap is checked first so a run that is both over-steps and over-time reports the
   * step cap (an arbitrary but stable tie-break).
   */
  checkBudget(budget: GuardrailBudget): GuardrailStopReason | null;
  /**
   * Feeds the fingerprint of the scene the loop is about to reason about. Returns
   * `"no-progress"` once the same fingerprint has been observed `maxRepeatedScreens` times
   * in a row (the screen has stopped changing), else `null`. Must be called once per scene,
   * in order, for the run-length to be meaningful.
   */
  observeScene(fingerprint: string): GuardrailStopReason | null;
}

/**
 * Builds a fresh guardrail set for one session. State (the no-progress run-length) is
 * per-instance, so a new session starts with a clean slate - construct one per run.
 */
export function createScreenAgentGuardrails(
  config: ScreenAgentGuardrailConfig = DEFAULT_SCREEN_AGENT_GUARDRAILS,
): ScreenAgentGuardrails {
  const { maxSteps, maxWallClockMs, maxRepeatedScreens } = config;

  // The no-progress detector's memory: the last scene's fingerprint and how many times in a
  // row it has now been seen (1 for a fresh fingerprint). Only meaningful when the detector
  // is enabled (maxRepeatedScreens > 0).
  let lastFingerprint: string | null = null;
  let repeatRunLength = 0;

  function checkBudget({ stepCount, elapsedMs }: GuardrailBudget): GuardrailStopReason | null {
    if (stepCount >= maxSteps) {
      return "step-cap";
    }
    if (elapsedMs >= maxWallClockMs) {
      return "timeout";
    }
    return null;
  }

  function observeScene(fingerprint: string): GuardrailStopReason | null {
    // A disabled detector never trips and keeps no state - the run is bounded by the step
    // cap and timeout alone.
    if (maxRepeatedScreens <= 0) {
      return null;
    }
    if (fingerprint === lastFingerprint) {
      repeatRunLength += 1;
    } else {
      lastFingerprint = fingerprint;
      repeatRunLength = 1;
    }
    return repeatRunLength >= maxRepeatedScreens ? "no-progress" : null;
  }

  return { checkBudget, observeScene };
}
