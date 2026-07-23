// Pure coordinate mapping for pointing (ticket 07): turns a model's Point Tag - a
// coordinate in a screenshot's captured-pixel space tagged with a 1-based screenN -
// into a real point on the global desktop, on the correct monitor.
//
// The Core already did its half (repairing the tag and remapping the model's
// downscaled coordinates back to captured-pixel space); this is the Shell's half,
// because only the Shell knows the OS display geometry. Keeping it a pure function of
// the capture geometry (rather than reaching into `screen` here) is what lets "the
// cursor never gestures at the wrong screen" (user story 25) be unit-tested without
// Electron. The main process resolves the live geometry and calls this.

/** A rectangle in the global-desktop logical coordinate space Electron reports. */
export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How one display was captured for a screen-aware turn: its 1-based screen number
 * (the same numbering the label carried to the model, so `screenN` maps straight
 * back), the Electron display id, the display's logical bounds, and the pixel size of
 * the screenshot that was actually captured (a downscaled thumbnail, so not the same
 * as the logical bounds - the mapping scales between the two).
 */
export interface DisplayCaptureGeometry {
  screenNumber: number;
  displayId: number;
  bounds: ScreenBounds;
  capturedWidth: number;
  capturedHeight: number;
}

/** A resolved pointing target: which display, and the global point to point at. */
export interface ResolvedPointTarget {
  displayId: number;
  bounds: ScreenBounds;
  /** The point in the global-desktop logical coordinate space. */
  screenX: number;
  screenY: number;
}

/**
 * Converts a resolved target's global-desktop point into the point local to its
 * display's Overlay window (whose top-left sits at the display's bounds origin). The
 * Overlay window covers exactly one display, so this is what the renderer positions
 * the cursor with. Kept beside the resolve step so the coordinate math lives in one
 * tested place rather than inline at the call site.
 */
export function toWindowLocalPoint(target: ResolvedPointTarget): { localX: number; localY: number } {
  return {
    localX: target.screenX - target.bounds.x,
    localY: target.screenY - target.bounds.y,
  };
}

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolves a Point Tag coordinate onto a global-desktop point on the correct monitor.
 *
 * The target display is the one whose `screenNumber` matches the tag; a `null`
 * screenN means the cursor's screen (screen 1, the model's primary focus). If the tag
 * names a screen that isn't in the geometry (a model hallucinating a monitor), it
 * falls back to screen 1 rather than guessing a wrong monitor. Returns `null` only
 * when there is no geometry at all to map against.
 *
 * Within the chosen display, the captured-pixel coordinate is expressed as a fraction
 * of the captured frame and applied to the display's logical bounds, so a downscaled
 * capture still lands at the right spot. The coordinate is clamped to the frame so a
 * slightly-out-of-bounds model coordinate points at the display's edge, never off it.
 */
export function resolveOverlayPointTarget(
  point: { x: number; y: number; screenNumber: number | null },
  geometry: DisplayCaptureGeometry[],
): ResolvedPointTarget | null {
  if (geometry.length === 0) {
    return null;
  }

  const requestedScreen = point.screenNumber;
  const cursorScreen =
    geometry.find((display) => display.screenNumber === 1) ?? geometry[0];
  const targetScreen =
    requestedScreen === null
      ? cursorScreen
      : geometry.find((display) => display.screenNumber === requestedScreen) ?? cursorScreen;

  // A zero-size capture can't be mapped as a fraction; land on the display origin
  // rather than producing NaN.
  const fractionX =
    targetScreen.capturedWidth > 0 ? clamp(point.x / targetScreen.capturedWidth, 0, 1) : 0;
  const fractionY =
    targetScreen.capturedHeight > 0 ? clamp(point.y / targetScreen.capturedHeight, 0, 1) : 0;

  return {
    displayId: targetScreen.displayId,
    bounds: targetScreen.bounds,
    screenX: Math.round(targetScreen.bounds.x + fractionX * targetScreen.bounds.width),
    screenY: Math.round(targetScreen.bounds.y + fractionY * targetScreen.bounds.height),
  };
}
