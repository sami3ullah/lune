import type {
  AgentAction,
  AgentDisplay,
  AgentScreenshot,
  AgentTargetSignal,
  ScreenAgentStepInput,
} from "@lune/core";
import { ScreenAgentNotReadyError } from "@lune/core";
import type { AgentDisplayGeometry } from "./agentCoordinateRemap";
import {
  AccessibilityNotGrantedError,
  SyntheticInputUnavailableError,
} from "./syntheticInputExecutor";
import type { GuardrailStopReason, ScreenAgentGuardrails } from "./screenAgentGuardrails";

// The Screen Agent loop (M2-03): one bounded run of the Shell-driven agent, end to end.
// It is the successor of v1's agent loop, drives the cadence the Core deliberately holds
// none of ("stopping the loop is simply the Shell ceasing to call"), and lives in the
// Shell because only the Shell touches the OS - it captures scenes, executes Actions, and
// speaks, while the Core only decides the next Action behind the injected `decideStep`.
//
// The cycle is decide -> confirm-if-needed -> execute -> capture -> decide again, over an
// overlay-excluded scene capture, guarded by the ported v1 guardrails (step cap,
// wall-clock timeout, no-progress screen fingerprint) and a clean stop on error. Two
// product rules live here:
//
//   - Advisory -> act boundary (DECISIONS #14): a first-Step `done` means the model chose
//     to *advise*, so the loop speaks and never touches the OS. Any answer-only turn ends
//     as `completed` with `advisory: true`, having executed zero Actions (acceptance #2).
//   - Confirm Gate (DECISIONS #15, revised): the irreversible guard fires before any
//     `consequential` Action. Confirm-to-start was dropped at the owner's request - an
//     explicit user command is consent to begin - so a run only gates hard-to-undo steps.
//     This ticket owns the *seam* (`confirm`) and calls it at that moment; M2-04 answers it
//     by voice (no on-screen modal). A declined gate ends the run cleanly (`declined`).
//
// Barge-in (the push-to-talk hotkey) cancels a session by aborting the injected
// `signal`: the loop checks it between every await and ceases to call, so a cancelled run
// leaves nothing executing (acceptance #4). Every OS/Core edge is injected, so the whole
// control flow - each guardrail, the advisory boundary, the confirm gate, cancellation,
// and error classification - is unit-testable against fakes (acceptance #3).

/**
 * One overlay-excluded scene capture the loop reasons about: the screenshot the Core
 * steps on, the geometry the executor remaps Action coordinates with, the active display
 * that sizes the first Step's computer tool, and the optional accessibility target signal
 * that feeds the Consequence floor. The single-active-display capture is bound for the
 * Session's life, matching the Core's coordinate-space contract.
 */
export interface SceneCapture {
  screenshot: AgentScreenshot;
  geometry: AgentDisplayGeometry;
  display: AgentDisplay;
  targetSignal?: AgentTargetSignal;
}

/**
 * One confirm request handed to the gate seam. The gate fires only before a `consequential`
 * (hard-to-undo) Action - a send, delete, pay, submit, overwrite, or irreversible navigation
 * - which M2-04 asks the user to approve by voice. Confirm-to-start was dropped (DECISIONS
 * #15, revised): an explicit command is consent to begin, so a run no longer gates just to
 * start.
 */
export interface ConfirmGateRequest {
  /** The Action about to run, so the gate can explain in plain language what Lune will do. */
  action: AgentAction;
  /** The 0-based index of the Action this gate precedes. */
  stepIndex: number;
  /**
   * The run's barge-in signal, so a gate waiting on the user can stop waiting the instant
   * the session is cancelled (a push-to-talk press) instead of hanging for an answer that
   * will never come. The loop still re-checks the signal after the gate resolves, so a
   * barge-in during a gate ends the run as `cancelled` (not `declined`).
   */
  signal?: AbortSignal;
}

/**
 * Why a run stopped. Every terminal path is one of these, so the Shell always knows how to
 * surface the outcome (speak the answer, acknowledge a decline, explain a guardrail stop,
 * route to the Accessibility pane) rather than hang.
 */
export type ScreenAgentStopReason =
  /** The model returned `done`: the goal is met, or (on Step 0) it chose to advise. */
  | "completed"
  /** A confirm gate was declined; the run ended without the pending Action. */
  | "declined"
  /** Barge-in / abort: the injected signal fired, so the loop ceased to call. */
  | "cancelled"
  /** A guardrail stopped the run: `"step-cap" | "timeout" | "no-progress"` (see the guardrails). */
  | GuardrailStopReason
  /** The Core reported the routed Vendor cannot act / has no key (before any upstream call). */
  | "not-ready"
  /** The executor refused because macOS Accessibility is not granted (route to the pane). */
  | "accessibility"
  /** The native input backend could not load, so synthetic input is unavailable this run. */
  | "unavailable"
  /** Any other failure (an upstream error, a bad Step input, a capture failure). */
  | "error";

/** The outcome of one Screen Agent run. */
export interface ScreenAgentRunResult {
  reason: ScreenAgentStopReason;
  /** How many Actions were actually executed against the OS before the run ended. */
  stepsExecuted: number;
  /** The spoken final text, present only when `reason === "completed"`. */
  finalText?: string;
  /** True when the first Step was `done`: the model advised and never touched the OS. */
  advisory: boolean;
  /** The underlying error, present only when `reason === "error"`. */
  error?: unknown;
}

/** The injected boundaries one Screen Agent run is driven through. */
export interface ScreenAgentLoopDependencies {
  /** The user's spoken goal for this session (required on the first Step). */
  goal: string;
  /** Identifies the Core Session; the first Step for this id starts a new Session. */
  sessionId: string;
  /** Captures the next overlay-excluded scene (single active display). */
  captureScene: () => Promise<SceneCapture>;
  /** Advances the Core Session one Step and returns the next canonical Action. */
  decideStep: (input: ScreenAgentStepInput) => Promise<AgentAction>;
  /** Performs one Action as real OS input, remapping via the capture's geometry. */
  execute: (action: AgentAction, geometry: AgentDisplayGeometry) => Promise<void>;
  /**
   * Flies the playful Overlay cursor to the Action's on-screen target and resolves once it
   * has landed, so the user sees where Lune is about to act *before* it acts - and a gated
   * Action shows the cursor waiting at the target while the gate is pending (M2-05). Called
   * for every executed Action, before the confirm gate; a no-op for Actions with no target.
   */
  showActionTarget: (action: AgentAction, geometry: AgentDisplayGeometry) => Promise<void>;
  /** Asks the user to confirm before an OS touch; resolves `true` to proceed. */
  confirm: (request: ConfirmGateRequest) => Promise<boolean>;
  /** Speaks the model's final text when the run completes (or advises). */
  speak: (finalText: string) => void | Promise<void>;
  /** The session guardrails (step cap, wall-clock, no-progress); construct one per run. */
  guardrails: ScreenAgentGuardrails;
  /** Fingerprints a scene for the no-progress detector (default: a hash of the bytes). */
  hashScreenshot: (screenshot: AgentScreenshot) => string;
  /** The clock the wall-clock timeout is measured against (injected for deterministic tests). */
  now: () => number;
  /** Barge-in / cancellation: the loop stops as soon as this is aborted. */
  signal?: AbortSignal;
}

/** Whether the run has been cancelled (barge-in) via the injected signal. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Builds a terminal result for a non-completed stop, carrying the executed-step count. */
function stop(
  reason: ScreenAgentStopReason,
  stepsExecuted: number,
  advisory: boolean,
  error?: unknown,
): ScreenAgentRunResult {
  return { reason, stepsExecuted, advisory, error };
}

/**
 * Classifies a thrown error into a terminal result so the run always stops cleanly. The
 * typed Core/executor errors map to the reasons the Shell handles specifically (not-ready,
 * route-to-Accessibility, native-module-missing); anything else is a generic `error`.
 */
function classifyError(error: unknown, stepsExecuted: number): ScreenAgentRunResult {
  if (error instanceof ScreenAgentNotReadyError) {
    return stop("not-ready", stepsExecuted, false, error);
  }
  if (error instanceof AccessibilityNotGrantedError) {
    return stop("accessibility", stepsExecuted, false, error);
  }
  if (error instanceof SyntheticInputUnavailableError) {
    return stop("unavailable", stepsExecuted, false, error);
  }
  // Everything else - an upstream failure, a bad Step input, a capture failure - folds
  // into the generic error stop; the run still ends cleanly rather than throwing.
  return stop("error", stepsExecuted, false, error);
}

/**
 * Runs one Screen Agent session to a terminal outcome. Never throws: every failure,
 * guardrail, decline, and cancellation resolves to a typed {@link ScreenAgentRunResult}
 * the Shell acts on. Executes an Action only after any required confirm gate approves and
 * only while the run has not been cancelled, so an answer-only turn or a barge-in leaves
 * the OS untouched.
 */
export async function runScreenAgentLoop(
  dependencies: ScreenAgentLoopDependencies,
): Promise<ScreenAgentRunResult> {
  const {
    goal,
    sessionId,
    captureScene,
    decideStep,
    execute,
    showActionTarget,
    confirm,
    speak,
    guardrails,
    hashScreenshot,
    now,
    signal,
  } = dependencies;

  const startedAt = now();
  let stepIndex = 0;

  try {
    // Cancelled before the first capture (an instant barge-in): stop with nothing done.
    if (isAborted(signal)) {
      return stop("cancelled", stepIndex, false);
    }

    // The initial scene: the loop always decides against a fresh capture, so it captures
    // once up front, then re-captures after each executed Action.
    let scene = await captureScene();

    // The loop is bounded by the guardrails below; the `for (;;)` never spins unbounded
    // because every path either returns or advances toward a guardrail limit.
    for (;;) {
      if (isAborted(signal)) {
        return stop("cancelled", stepIndex, false);
      }

      // Budget guardrails (step cap + wall-clock) before spending another Step.
      const budgetStop = guardrails.checkBudget({
        stepCount: stepIndex,
        elapsedMs: now() - startedAt,
      });
      if (budgetStop !== null) {
        return stop(budgetStop, stepIndex, false);
      }

      // No-progress guardrail on the scene we are about to reason about: a screen that has
      // stopped changing for too long means the run is stuck, not working.
      const progressStop = guardrails.observeScene(hashScreenshot(scene.screenshot));
      if (progressStop !== null) {
        return stop(progressStop, stepIndex, false);
      }

      // Decide one Step. Only the first Step carries the goal + display (a continuing
      // Session reuses both); the target signal feeds the Core's Consequence floor.
      const action = await decideStep({
        sessionId,
        screenshot: scene.screenshot,
        goal: stepIndex === 0 ? goal : undefined,
        display: stepIndex === 0 ? scene.display : undefined,
        targetSignal: scene.targetSignal,
      });

      // Terminal: the model decided the goal is met. On Step 0 this is the advisory case -
      // it chose to answer, not act, so the loop speaks and never touches the OS.
      if (action.kind === "done") {
        const advisory = stepIndex === 0;
        await speak(action.finalText);
        return { reason: "completed", stepsExecuted: stepIndex, finalText: action.finalText, advisory };
      }

      // Fly the playful cursor to where this Action will act, so the user sees Lune's target
      // before anything happens - and a gated Action shows the cursor already waiting there
      // while the gate is pending (M2-05). A no-op for Actions with no on-screen target.
      await showActionTarget(action, scene.geometry);

      // A barge-in can land during the flight's settle; honour it before the gate or any OS
      // touch, so a cancelled run neither prompts a gate nor executes the Action it decided.
      if (isAborted(signal)) {
        return stop("cancelled", stepIndex, false);
      }

      // Confirm only before a consequential (hard-to-undo) Action - a send, delete, pay,
      // submit, overwrite, or irreversible navigation. An explicit command is consent to
      // start, so a run no longer gates just to begin; benign Actions run without a gate.
      if (action.consequence === "consequential") {
        const approved = await confirm({ action, stepIndex, signal });
        // A barge-in can land while the user is answering the gate. Honour it first, so a
        // cancelled run is reported as `cancelled` rather than misread as a `declined` gate
        // (the gate resolves not-approved when its wait is aborted).
        if (isAborted(signal)) {
          return stop("cancelled", stepIndex, false);
        }
        if (!approved) {
          return stop("declined", stepIndex, false);
        }
      }

      // Honour a barge-in before any OS touch, unconditionally - covers both the gated path
      // (a press during the confirm await) and the benign, non-gated path (a press during the
      // preceding decide await). A cancelled run must never execute the Action it just decided.
      if (isAborted(signal)) {
        return stop("cancelled", stepIndex, false);
      }

      // Execute: the one place the loop touches the OS.
      await execute(action, scene.geometry);
      stepIndex += 1;

      // Capture the fresh scene the next Step decides against.
      scene = await captureScene();
    }
  } catch (error) {
    return classifyError(error, stepIndex);
  }
}
