import type { AgentAction } from "@lune/core";

// Pure coordinate remap for the synthetic input executor (M2-02): turns a canonical
// Action's coordinate - which the Screen Agent Vendor produced in the *screenshot-pixel*
// space of the display the Session is bound to - into a real point on the global desktop
// in the logical (point/DIP) space synthetic input uses.
//
// The Core did its half (returning one canonical Action per Step in the display's
// screenshot space); this is the Shell's half, because only the Shell knows the OS
// display geometry. Keeping it a pure function of the capture geometry (rather than
// reaching into Electron's `screen` here) is what lets "coordinates land correctly on
// secondary displays and scaled resolutions" (acceptance #2) be unit-tested without
// Electron or real input. It is the single-display sibling of the Overlay's Point Tag
// remap (`overlay/overlayGeometry.ts`); a Session is bound to one display for its life,
// so there is exactly one geometry to map against.
//
// Both Electron's `screen` bounds and the native input backend (nut.js / CGEvent) work
// in the same global logical-point space with the primary display's top-left at the
// origin, so no backing-scale flip is needed here: expressing the captured-pixel
// coordinate as a fraction of the captured frame and applying it to the display's
// logical bounds handles both the multi-display offset and any non-1:1 capture scale.

/** A rectangle in the global-desktop logical coordinate space Electron reports. */
export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How the Session's single active display was captured: its logical bounds on the global
 * desktop, and the pixel size of the screenshot that was actually sent to the Vendor (the
 * space the returned Action coordinates are in). The two differ whenever the capture was
 * downscaled or the panel is Retina, so the remap scales between them.
 */
export interface AgentDisplayGeometry {
  bounds: ScreenBounds;
  capturedWidth: number;
  capturedHeight: number;
}

/** A point in the global-desktop logical coordinate space synthetic input uses. */
export interface GlobalPoint {
  x: number;
  y: number;
}

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Remaps a screenshot-pixel point onto the global-desktop logical point on the bound
 * display. The coordinate is expressed as a fraction of the captured frame and applied to
 * the display's logical bounds, so a downscaled or Retina capture still lands at the right
 * spot. It is clamped to the frame so a slightly-out-of-bounds model coordinate points at
 * the display's edge, never off it; a zero-size capture lands on the display origin rather
 * than producing NaN.
 */
export function remapScreenshotPointToGlobal(
  point: { x: number; y: number },
  geometry: AgentDisplayGeometry,
): GlobalPoint {
  const { bounds, capturedWidth, capturedHeight } = geometry;
  const fractionX = capturedWidth > 0 ? clamp(point.x / capturedWidth, 0, 1) : 0;
  const fractionY = capturedHeight > 0 ? clamp(point.y / capturedHeight, 0, 1) : 0;
  return {
    x: Math.round(bounds.x + fractionX * bounds.width),
    y: Math.round(bounds.y + fractionY * bounds.height),
  };
}

/**
 * Returns the Action with any display-space coordinate remapped to global logical space.
 * `click` and `scroll` carry a point; a compound `type` carries an optional click target
 * that is remapped only when present (a focus-typing `type` has none). `key`, `copy`,
 * `observe`, and `done` carry no coordinate and pass through unchanged. The Action's kind,
 * text, direction, amount, and Consequence Level are preserved - only coordinates change.
 */
export function remapActionToGlobalSpace(
  action: AgentAction,
  geometry: AgentDisplayGeometry,
): AgentAction {
  switch (action.kind) {
    case "click":
    case "scroll": {
      // Both carry a mandatory point in the same field names; the spread preserves the
      // rest (direction/amount/consequence) so one arm serves both kinds.
      const point = remapScreenshotPointToGlobal({ x: action.x, y: action.y }, geometry);
      return { ...action, x: point.x, y: point.y };
    }
    case "type": {
      if (action.x === undefined || action.y === undefined) {
        return action;
      }
      const point = remapScreenshotPointToGlobal({ x: action.x, y: action.y }, geometry);
      return { ...action, x: point.x, y: point.y };
    }
    default:
      return action;
  }
}
