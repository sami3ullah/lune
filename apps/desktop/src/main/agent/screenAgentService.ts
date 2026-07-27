import { createHash } from "node:crypto";
import { nativeImage } from "electron";
import type { AgentScreenshot, ScreenAgentCapability } from "@lune/core";
import {
  runScreenAgentLoop,
  type ConfirmGateRequest,
  type ScreenAgentRunResult,
} from "./screenAgentLoop";
import {
  createScreenAgentGuardrails,
  DEFAULT_SCREEN_AGENT_GUARDRAILS,
  type ScreenAgentGuardrailConfig,
} from "./screenAgentGuardrails";
import {
  captureAgentScene,
  resolveActiveDisplayId,
  type OverlaySuspender,
} from "./agentSceneCapture";
import { fingerprintBitmap, PROGRESS_GRID } from "./progressFingerprint";
import type { SyntheticInputExecutor } from "./syntheticInputExecutor";
import type { AxSignalProvider } from "./axSignalProvider";
import {
  createAgentCursorPresenter,
  type AgentCursorOverlay,
} from "./agentCursorPresenter";

// Composes the Screen Agent loop (M2-03) for the Electron main process: it wires the loop's
// injected seams to the real edges - the Core's step (`ScreenAgentCapability`), the
// synthetic input executor (M2-02), the overlay-excluded scene capture, and the confirm
// gate - so the main process can start one bounded run from a spoken goal. The loop itself
// is the tested control flow; this is the thin wiring, mirroring the transcription/speech/
// synthetic-input services.
//
// The confirm gate is a seam here on purpose: M2-03 owns *when* the loop confirms (only
// before a consequential, hard-to-undo Action now - confirm-to-start was dropped); the UX
// behind it is M2-04, injected by the composition root (`createConfirmGateController` wired
// to push-to-talk voice, no on-screen modal). The {@link autoApproveConfirmGate} default
// remains only so a run can be exercised in isolation (tests / a headless dev trigger) where
// no gate UX is mounted; the real app always passes the real gate.

/** A confirm gate: decide whether the loop may proceed with the Action it is about to run. */
export type ConfirmGate = (request: ConfirmGateRequest) => Promise<boolean>;

/**
 * The placeholder confirm gate used until M2-04 wires the real chip/voice/hotkey UX: it
 * logs what it would ask and approves, so a Screen Agent run can be exercised end to end
 * now. NOT the shipping behaviour - a consequential Action must not silently proceed once
 * M2-04 lands; this exists only so M2-03's loop is demonstrable before the gate UX does.
 */
export function autoApproveConfirmGate(log: (message: string) => void): ConfirmGate {
  return async (request) => {
    log(
      `confirm gate auto-approved for a consequential '${request.action.kind}' action ` +
        `[M2-04 replaces this with the real voice gate]`,
    );
    return true;
  };
}

/**
 * Fingerprints a scene for the no-progress detector: decodes the frame, downscales it to the
 * coarse grid, and hands the bitmap to the pure {@link fingerprintBitmap} (see that module for
 * why a coarse, quantized fingerprint - not a byte-exact hash - is what stops a stuck model
 * from looping forever). Falls back to a raw-bytes hash if the frame can't be decoded.
 */
function hashScreenshot(screenshot: AgentScreenshot): string {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(screenshot.base64Data, "base64"));
    if (image.isEmpty()) {
      return createHash("sha1").update(screenshot.base64Data).digest("hex");
    }
    const bitmap = image
      .resize({ width: PROGRESS_GRID, height: PROGRESS_GRID, quality: "good" })
      .toBitmap(); // row-major BGRA bytes
    return fingerprintBitmap(Uint8Array.from(bitmap));
  } catch {
    return createHash("sha1").update(screenshot.base64Data).digest("hex");
  }
}

/** The edges the Screen Agent service is composed from. */
export interface ScreenAgentServiceDependencies {
  /** The Core's Screen Agent Capability: advances one Session by one Step (the decide). */
  capability: ScreenAgentCapability;
  /** The synthetic input executor: performs one Action as real OS input (the execute). */
  executor: SyntheticInputExecutor;
  /** Suspends/resumes Lune's overlay windows around each capture (overlay exclusion). */
  overlay: OverlaySuspender;
  /**
   * Reads the accessibility target signal each capture (M2-05), feeding the Core's
   * Consequence floor so a click on a "Send"/hyperlink element escalates to a Confirm Gate.
   * Optional: without it, captures carry no target signal and the floor simply never
   * escalates (the pre-M2-05 behaviour), so tests and headless runs can omit it.
   */
  axProvider?: AxSignalProvider;
  /**
   * Flies the playful Overlay cursor to each Action's target before it executes (M2-05), so
   * the user sees where Lune is about to act. Optional: without it the loop's
   * `showActionTarget` is a no-op, so a headless run acts without the animation.
   */
  overlayCursor?: AgentCursorOverlay;
  /** Speaks the model's final text when a run completes (or advises). */
  speak: (finalText: string) => void | Promise<void>;
  /** Mints a Session id for each run (injected so tests are deterministic). */
  generateSessionId: () => string;
  /** The confirm gate; defaults to {@link autoApproveConfirmGate} until M2-04. */
  confirm?: ConfirmGate;
  /** The session guardrails; defaults to {@link DEFAULT_SCREEN_AGENT_GUARDRAILS}. */
  guardrailConfig?: ScreenAgentGuardrailConfig;
  /** The clock the wall-clock timeout is measured against; defaults to `Date.now`. */
  now?: () => number;
}

/** One Screen Agent run to start: the spoken goal and the barge-in cancellation signal. */
export interface RunScreenAgentOptions {
  goal: string;
  /** Aborts the session on Barge-in; the loop then ceases to call and leaves the OS untouched. */
  signal?: AbortSignal;
}

/** Starts bounded Screen Agent runs over the real OS/Core edges. */
export interface ScreenAgentService {
  /** Runs one Session to a terminal outcome; never throws (see {@link ScreenAgentRunResult}). */
  run(options: RunScreenAgentOptions): Promise<ScreenAgentRunResult>;
}

export function createScreenAgentService(
  dependencies: ScreenAgentServiceDependencies,
): ScreenAgentService {
  const {
    capability,
    executor,
    overlay,
    axProvider,
    overlayCursor,
    speak,
    generateSessionId,
    confirm,
    guardrailConfig = DEFAULT_SCREEN_AGENT_GUARDRAILS,
    now = () => Date.now(),
  } = dependencies;

  const confirmGate = confirm ?? autoApproveConfirmGate((message) => console.log(`[lune] ${message}`));

  async function run(options: RunScreenAgentOptions): Promise<ScreenAgentRunResult> {
    // Bind the display for the Session's whole life (matching the Core's coordinate space),
    // then re-capture that same display each Step.
    const displayId = resolveActiveDisplayId();

    // The cursor presenter is per-run: it flies the Overlay cursor on the bound display and
    // remembers the previous target to time each hop. Without an overlay cursor edge (a
    // headless run), `showActionTarget` is a no-op so the loop acts without the animation.
    const presenter =
      overlayCursor !== undefined
        ? createAgentCursorPresenter({ overlay: overlayCursor, displayId })
        : null;
    const showActionTarget = presenter?.showActionTarget ?? (async () => {});

    try {
      return await runScreenAgentLoop({
        goal: options.goal,
        sessionId: generateSessionId(),
        captureScene: () => captureAgentScene(displayId, overlay, axProvider),
        decideStep: (input) => capability.step(input),
        execute: (action, geometry) => executor.execute(action, geometry),
        showActionTarget,
        confirm: confirmGate,
        speak,
        guardrails: createScreenAgentGuardrails(guardrailConfig),
        hashScreenshot,
        now,
        signal: options.signal,
      });
    } finally {
      // However the run ended (done, declined, cancelled, guardrail, error), release the
      // cursor so it flies back to the mouse rather than freezing at the last target.
      presenter?.finish();
    }
  }

  return { run };
}

/** The env var whose value (a spoken goal) runs the dev trigger; absent = no-op. */
const AGENT_LOOP_DEV_ENV = "LUNE_AGENT_LOOP_DEV";

/** Options for {@link runScreenAgentDevTrigger}. */
export interface ScreenAgentDevTriggerOptions {
  /** Where progress/outcome lines go; defaults to the console. */
  log?: (message: string) => void;
  /**
   * Opens the OS Accessibility pane, called when a run stops because the grant is missing,
   * so the degrade path is "clean explanation -> route to the pane, never a silent no-op"
   * (the epic's Accessibility rule) rather than only logging.
   */
  routeToAccessibilityPane?: () => void;
  /**
   * Registers the run's abort handle so a push-to-talk press cancels the session (Barge-in),
   * exactly as a Chat turn registers with the voice loop. Paired with
   * {@link ScreenAgentDevTriggerOptions.unregisterBargeIn} when the run ends.
   */
  registerBargeIn?: (abort: AbortController) => void;
  /** Unregisters the run's abort handle once the run ends. */
  unregisterBargeIn?: (abort: AbortController) => void;
}

/**
 * The env-gated dev trigger (on `LUNE_AGENT_LOOP_DEV`) that runs one Screen Agent session
 * from the env var's value as the goal, before the advisory->act auto-routing exists -
 * mirroring the synthetic-input/transcription dev triggers. It demonstrates a real
 * multi-step run end to end (acceptance #1), the 1-step type-at-cursor case (set the goal
 * to "type ... where my cursor is"), and hotkey cancellation (acceptance #4) via the
 * registered Barge-in handle. A missing Accessibility grant routes to the pane rather than
 * silently doing nothing. A no-op when the env var is absent, so a normal launch does
 * nothing.
 *
 * @returns whether a run was actually started.
 */
export async function runScreenAgentDevTrigger(
  service: ScreenAgentService,
  options: ScreenAgentDevTriggerOptions = {},
): Promise<boolean> {
  const log = options.log ?? ((message: string) => console.log(`[lune] ${message}`));
  const goal = process.env[AGENT_LOOP_DEV_ENV]?.trim();
  if (goal === undefined || goal.length === 0) {
    return false;
  }

  const abort = new AbortController();
  options.registerBargeIn?.(abort);
  log(`screen agent dev trigger: starting a run for goal "${goal}"`);
  try {
    const result = await service.run({ goal, signal: abort.signal });
    log(
      `screen agent dev trigger: run ended (${result.reason}) after ${result.stepsExecuted} step(s)` +
        (result.finalText !== undefined ? ` - "${result.finalText}"` : ""),
    );
    if (result.reason === "accessibility") {
      // Degrade cleanly: the loop already stopped with the user-facing explanation; route to
      // the pane so the grant can be fixed rather than leaving the user with nothing.
      options.routeToAccessibilityPane?.();
    }
  } finally {
    options.unregisterBargeIn?.(abort);
  }
  return true;
}
