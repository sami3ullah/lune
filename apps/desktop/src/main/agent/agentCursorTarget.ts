import type { AgentAction } from "@lune/core";
import {
  remapScreenshotPointToGlobal,
  type AgentDisplayGeometry,
} from "./agentCoordinateRemap";

// The pure half of M2-05's "the cursor acts the part": before an Action executes, the
// playful Overlay cursor flies to where Lune is about to act, so gates and actions are
// legible (the user sees the target, and a gated Action shows the cursor waiting there).
// This module answers two pure questions - *where* on the display the cursor should land for
// a given Action, and *how long* that flight takes - so the presenter (`agentCursorPresenter`,
// the thin edge that drives the Overlay window and sleeps) stays a trivial shell over tested
// math, exactly as `overlayCursorFlight` is the tested core under the chat overlay.

/** Where the Overlay cursor should fly for an Action, in its display's window-local space. */
export interface AgentCursorTarget {
  /** X within the bound display's Overlay window, in logical pixels from its top-left. */
  localX: number;
  /** Y within the bound display's Overlay window, in logical pixels from its top-left. */
  localY: number;
  /** The short human label shown beside the cursor while it points (the pointer bubble). */
  label: string;
}

/** How many characters of a typed string appear in its label before it is truncated. */
const TYPE_SNIPPET_MAX = 24;

/**
 * A short, human phrase for what an Action does - the label shown beside the cursor as it
 * points at the target. Kept terse: a typed string is quoted and truncated so the pointer
 * bubble never grows unwieldy.
 */
export function describeAgentAction(action: AgentAction): string {
  switch (action.kind) {
    case "click":
      return "Click";
    case "scroll":
      return "Scroll";
    case "copy":
      return "Copy";
    case "observe":
      return "Look";
    case "done":
      return "Done";
    case "key":
      return `Press ${action.combo}`;
    case "type": {
      const snippet =
        action.text.length > TYPE_SNIPPET_MAX
          ? `${action.text.slice(0, TYPE_SNIPPET_MAX)}...`
          : action.text;
      return `Type "${snippet}"`;
    }
  }
}

/**
 * Resolves the Overlay-local point the cursor should fly to before `action` executes, or
 * `null` when the Action has no on-screen target to fly to (a type-at-focus, a key combo, a
 * clipboard write, an observe, or the terminal done - the cursor simply stays put for those).
 *
 * The Action's coordinate is in the capture's screenshot-pixel space; it is remapped to the
 * global-desktop point with the same geometry the executor uses (so the cursor lands exactly
 * where the click will), then expressed relative to the display's origin - the Overlay window
 * covers one display with its top-left at that origin, so this is the point the renderer
 * positions the cursor with.
 */
export function resolveAgentCursorTarget(
  action: AgentAction,
  geometry: AgentDisplayGeometry,
): AgentCursorTarget | null {
  const point = actionTargetPoint(action);
  if (point === null) {
    return null;
  }
  const global = remapScreenshotPointToGlobal(point, geometry);
  return {
    localX: global.x - geometry.bounds.x,
    localY: global.y - geometry.bounds.y,
    label: describeAgentAction(action),
  };
}

/** The Action's own captured-pixel target point, or `null` when it targets no coordinate. */
function actionTargetPoint(action: AgentAction): { x: number; y: number } | null {
  switch (action.kind) {
    case "click":
    case "scroll":
      return { x: action.x, y: action.y };
    case "type":
      // A compound type (Gemini's `type_text_at`) clicks a point first; a focus-typing type
      // has none, so the cursor stays where it is.
      return action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : null;
    default:
      return null;
  }
}

/** Flight-duration knobs, mirroring `overlayCursorFlight` so the wait matches the animation. */
const MIN_FLIGHT_MS = 600;
const MAX_FLIGHT_MS = 1400;
const MS_PER_PIXEL = 1000 / 800;
/** A beat added after the flight so the Action fires only once the cursor has visibly landed. */
const SETTLE_BUFFER_MS = 250;

/**
 * The longest {@link agentCursorSettleMs} can return - the worst-case flight plus the settle.
 * The presenter uses it for the first hop of a run, where the cursor's start (the real mouse)
 * isn't known, so the wait covers even a full-screen flight rather than firing early.
 */
export const AGENT_CURSOR_SETTLE_MAX_MS = MAX_FLIGHT_MS + SETTLE_BUFFER_MS;

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * How long to wait after telling the Overlay to fly the cursor from `from` to `to` before
 * the Action executes - the flight duration (proportional to distance, clamped to the same
 * range the renderer animates over) plus a short settle so the cursor has visibly arrived.
 * A pure function of the two points so the presenter's timing is testable without a clock.
 */
export function agentCursorSettleMs(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return clamp(distance * MS_PER_PIXEL, MIN_FLIGHT_MS, MAX_FLIGHT_MS) + SETTLE_BUFFER_MS;
}
