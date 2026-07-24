import type { AgentAction } from "@lune/core";
import type { AgentDisplayGeometry } from "./agentCoordinateRemap";
import {
  agentCursorSettleMs,
  resolveAgentCursorTarget,
  AGENT_CURSOR_SETTLE_MAX_MS,
  type AgentCursorTarget,
} from "./agentCursorTarget";

// The thin edge behind M2-05's "the cursor acts the part": before an Action executes, fly
// the playful Overlay cursor to the Action's on-screen target and wait for it to land, so
// the user sees where Lune is about to act (and a gated Action shows the cursor waiting at
// the target while the gate is pending). It is a shell over the tested `agentCursorTarget`
// math - resolve the local point, tell the Overlay window to fly there, sleep the flight's
// duration - with the Overlay send and the clock injected so the sequencing is unit-tested
// without a real window or real time.
//
// It reuses the same `point` Overlay event the chat overlay flies on, so no renderer change
// is needed: each Action sends a fresh target and the cursor hops target-to-target, holding
// at each (the renderer holds a point until an interaction ends, which a Screen Agent run
// never signals) so it visibly waits through any Confirm Gate.

/** The Overlay seam the presenter drives: fly the cursor on one display to a target point. */
export interface AgentCursorOverlay {
  /** Sends a pointing target to the bound display's Overlay window (fire-and-forget). */
  pointCursorAt(displayId: number, target: AgentCursorTarget): void;
  /**
   * Ends the pointing interaction on the display, so the cursor flies back to the real mouse
   * and resumes following. Sent once when a run ends - the Screen Agent only ever sends
   * `point`s (it hops target to target), so without this the buddy would stay frozen at the
   * last Action's target after the run finished instead of returning to the user's mouse.
   */
  endPointing(displayId: number): void;
}

/** Flies the Overlay cursor to an Action's target and resolves once it has landed. */
export type ShowActionTarget = (
  action: AgentAction,
  geometry: AgentDisplayGeometry,
) => Promise<void>;

/** Drives the Overlay cursor across one Screen Agent run: fly to each target, then release. */
export interface AgentCursorPresenter {
  /** Flies the cursor to an Action's target before it executes (the loop's `showActionTarget`). */
  showActionTarget: ShowActionTarget;
  /** Releases the cursor back to the mouse when the run ends; safe to call if nothing pointed. */
  finish(): void;
}

/** The edges the cursor presenter is built over (all injected so it is testable). */
export interface AgentCursorPresenterDependencies {
  overlay: AgentCursorOverlay;
  /** The display the Session is bound to (the one every capture and flight happens on). */
  displayId: number;
  /** Sleeps for `ms`; injected so tests drive the timing without a real clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** Sleeps for `ms` (the production settle wait). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the {@link ShowActionTarget} the Screen Agent loop calls before each Action. For an
 * Action with no on-screen target (a type-at-focus, a key combo, a copy, an observe) it
 * resolves immediately without moving the cursor. Otherwise it tells the Overlay to fly the
 * cursor to the target and waits the flight's duration - from the previous target for a
 * within-run hop (so a short hop waits less), or the worst case for the first hop (where the
 * cursor's start, the real mouse, isn't known here).
 */
export function createAgentCursorPresenter(
  dependencies: AgentCursorPresenterDependencies,
): AgentCursorPresenter {
  const { overlay, displayId, sleep = realSleep } = dependencies;
  let lastTarget: { x: number; y: number } | null = null;

  const showActionTarget: ShowActionTarget = async (action, geometry) => {
    const target = resolveAgentCursorTarget(action, geometry);
    if (target === null) {
      // No coordinate to fly to: the cursor stays where it is (e.g. type-at-focus).
      return;
    }

    overlay.pointCursorAt(displayId, target);

    const landing = { x: target.localX, y: target.localY };
    const settleMs =
      lastTarget === null ? AGENT_CURSOR_SETTLE_MAX_MS : agentCursorSettleMs(lastTarget, landing);
    lastTarget = landing;

    await sleep(settleMs);
  };

  function finish(): void {
    // Only release if we actually pointed - an advisory run (never touched the OS) left the
    // cursor following the mouse the whole time, so there is nothing to return.
    if (lastTarget !== null) {
      overlay.endPointing(displayId);
    }
  }

  return { showActionTarget, finish };
}
