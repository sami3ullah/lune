import { clipboard, screen, systemPreferences } from "electron";
import type { AgentAction } from "@lune/core";
import {
  AccessibilityNotGrantedError,
  createSyntheticInputExecutor,
  SyntheticInputUnavailableError,
  type SyntheticInputExecutor,
} from "./syntheticInputExecutor";
import { createNutjsInputBackend } from "./nutjsInputBackend";
import type { AgentDisplayGeometry } from "./agentCoordinateRemap";

// Composes the real macOS synthetic input executor for the Electron main process
// (M2-02): the platform-neutral executor wired to the nut.js native backend, Electron's
// `clipboard` for `copy`, and the macOS Accessibility trust check the app already uses
// for the push-to-talk hook. The Screen Agent loop (a later M2 ticket) drives this; until
// then, an env-gated dev trigger exercises it end to end.

/** Whether this process is a trusted macOS Accessibility client (always true off macOS). */
function isAccessibilityTrusted(): boolean {
  if (process.platform !== "darwin") {
    return true;
  }
  // `false` = read the trust bit without popping the system pane; onboarding owns the
  // explicit prompt (DECISIONS #22), so the executor only ever reads the grant silently.
  return systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * Builds the synthetic input executor over the real OS edges. Reuses the Accessibility
 * grant from M1 onboarding rather than prompting; if a run reaches it ungranted, the
 * executor throws {@link AccessibilityNotGrantedError} for the caller to route the user to
 * the Accessibility pane (acceptance #3).
 */
export function createDesktopSyntheticInputExecutor(): SyntheticInputExecutor {
  return createSyntheticInputExecutor({
    backend: createNutjsInputBackend(),
    clipboard: { writeText: (text) => clipboard.writeText(text) },
    isAccessibilityTrusted,
  });
}

/** The env var whose presence runs the dev trigger; its value selects the Action kind. */
const AGENT_INPUT_DEV_ENV = "LUNE_AGENT_INPUT_DEV";

/**
 * Builds the canned Action the dev trigger performs, from the env var's value. Defaults to
 * a benign small scroll at the display centre (visible, non-destructive); other values let
 * a developer exercise each kind manually. Click/scroll target the centre of the primary
 * display; the geometry passed to the executor is 1:1 with that display, so the remap is a
 * clean pass-through.
 */
function devTriggerAction(kind: string, centre: { x: number; y: number }): AgentAction {
  switch (kind) {
    case "click":
      return { kind: "click", x: centre.x, y: centre.y, consequence: "benign" };
    case "type":
      return { kind: "type", text: "lune synthetic input ok", consequence: "benign" };
    case "key":
      return { kind: "key", combo: "cmd+a", consequence: "benign" };
    case "copy":
      return { kind: "copy", text: "lune synthetic input clipboard", consequence: "benign" };
    case "scroll":
    default:
      return { kind: "scroll", x: centre.x, y: centre.y, direction: "down", amount: 3, consequence: "benign" };
  }
}

/** Options for {@link runSyntheticInputDevTrigger}. */
export interface SyntheticInputDevTriggerOptions {
  /** Where progress/outcome lines go; defaults to the console. */
  log?: (message: string) => void;
  /**
   * Opens the OS Accessibility pane, called when the executor refuses because the grant is
   * missing. Injected (the main process owns the pane URL) so the degrade path is
   * demonstrably "clean explanation -> route to the Accessibility pane, never a silent
   * no-op" (acceptance #3) rather than only logging.
   */
  routeToAccessibilityPane?: () => void;
}

/**
 * The env-gated dev trigger (on `LUNE_AGENT_INPUT_DEV`) that exercises the executor before
 * the Screen Agent loop exists (acceptance #1), mirroring the transcription/speech dev
 * triggers. It performs one canned Action against the primary display and logs the
 * outcome; if Accessibility is not granted it logs the clean explanation AND routes to the
 * Accessibility pane rather than silently doing nothing (acceptance #3), and if the native
 * module is missing it logs that too. A no-op when the env var is absent, so a normal
 * launch does nothing.
 *
 * @returns whether an Action was actually attempted.
 */
export async function runSyntheticInputDevTrigger(
  executor: SyntheticInputExecutor,
  options: SyntheticInputDevTriggerOptions = {},
): Promise<boolean> {
  const log = options.log ?? ((message: string) => console.log(`[lune] ${message}`));
  const requestedKind = process.env[AGENT_INPUT_DEV_ENV]?.trim();
  if (requestedKind === undefined || requestedKind.length === 0) {
    return false;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const geometry: AgentDisplayGeometry = {
    bounds: primaryDisplay.bounds,
    capturedWidth: primaryDisplay.bounds.width,
    capturedHeight: primaryDisplay.bounds.height,
  };
  const centre = {
    x: Math.round(primaryDisplay.bounds.width / 2),
    y: Math.round(primaryDisplay.bounds.height / 2),
  };
  const action = devTriggerAction(requestedKind, centre);

  log(`synthetic input dev trigger: performing a '${action.kind}' Action on the primary display`);
  try {
    await executor.execute(action, geometry);
    log(`synthetic input dev trigger: '${action.kind}' performed`);
  } catch (error) {
    if (error instanceof AccessibilityNotGrantedError) {
      // Degrade cleanly: explain, then route the user to the Accessibility pane so the
      // grant can be fixed - never a silent no-op (acceptance #3).
      log(`synthetic input dev trigger: ${error.message}`);
      options.routeToAccessibilityPane?.();
    } else if (error instanceof SyntheticInputUnavailableError) {
      log(`synthetic input dev trigger: ${error.message}`);
    } else {
      throw error;
    }
  }
  return true;
}
