import type { ParsedShape } from "@lune/core";
import type { OverlayShape } from "../../ipc/overlayControl";

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
 * Chooses which captured display a tagged coordinate belongs to. The target display is
 * the one whose `screenNumber` matches the tag; a `null` screenN means the cursor's
 * screen (screen 1, the model's primary focus). If the tag names a screen that isn't in
 * the geometry (a model hallucinating a monitor), it falls back to screen 1 rather than
 * guessing a wrong monitor. Returns `null` only when there is no geometry to map against.
 * Shared by the Point Tag and Shape Tag resolvers so both pick the monitor identically.
 */
export function selectTargetScreen(
  requestedScreen: number | null,
  geometry: DisplayCaptureGeometry[],
): DisplayCaptureGeometry | null {
  if (geometry.length === 0) {
    return null;
  }
  const cursorScreen = geometry.find((display) => display.screenNumber === 1) ?? geometry[0]!;
  if (requestedScreen === null) {
    return cursorScreen;
  }
  return geometry.find((display) => display.screenNumber === requestedScreen) ?? cursorScreen;
}

/**
 * Maps a captured-pixel coordinate to a fraction of its display's captured frame, applied
 * to the display's logical bounds. A downscaled capture still lands at the right spot, and
 * the coordinate is clamped to the frame so a slightly-out-of-bounds model coordinate
 * lands at the display's edge, never off it. A zero-size capture maps to the origin rather
 * than producing NaN.
 */
function capturedFraction(display: DisplayCaptureGeometry, x: number, y: number): { fx: number; fy: number } {
  return {
    fx: display.capturedWidth > 0 ? clamp(x / display.capturedWidth, 0, 1) : 0,
    fy: display.capturedHeight > 0 ? clamp(y / display.capturedHeight, 0, 1) : 0,
  };
}

/**
 * Resolves a Point Tag coordinate onto a global-desktop point on the correct monitor.
 * The monitor is chosen by {@link selectTargetScreen}; within it the captured-pixel
 * coordinate is mapped as a fraction of the captured frame onto the display's logical
 * bounds. Returns `null` only when there is no geometry to map against.
 */
export function resolveOverlayPointTarget(
  point: { x: number; y: number; screenNumber: number | null },
  geometry: DisplayCaptureGeometry[],
): ResolvedPointTarget | null {
  const targetScreen = selectTargetScreen(point.screenNumber, geometry);
  if (targetScreen === null) {
    return null;
  }

  const { fx, fy } = capturedFraction(targetScreen, point.x, point.y);
  return {
    displayId: targetScreen.displayId,
    bounds: targetScreen.bounds,
    screenX: Math.round(targetScreen.bounds.x + fx * targetScreen.bounds.width),
    screenY: Math.round(targetScreen.bounds.y + fy * targetScreen.bounds.height),
  };
}

/**
 * Converts a global-desktop rectangle (the onboarding window) into one display's Overlay-
 * window-local space (M3-03), clipped to that display, or `null` when the two don't
 * overlap. The Overlay window's origin is the display's bounds origin, so local == global
 * minus the bounds origin; clipping to the display keeps the returned rect within the
 * window so the renderer's placement math sees the wizard exactly where it sits on this
 * screen. Kept beside {@link toWindowLocalPoint} so the coordinate math stays in one tested
 * place - the cursor-riding intro card is kept clear of this rect.
 */
export function toDisplayLocalRect(
  globalRect: ScreenBounds,
  displayBounds: ScreenBounds,
): ScreenBounds | null {
  const left = Math.max(globalRect.x, displayBounds.x);
  const top = Math.max(globalRect.y, displayBounds.y);
  const right = Math.min(globalRect.x + globalRect.width, displayBounds.x + displayBounds.width);
  const bottom = Math.min(globalRect.y + globalRect.height, displayBounds.y + displayBounds.height);
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    x: left - displayBounds.x,
    y: top - displayBounds.y,
    width: right - left,
    height: bottom - top,
  };
}

/** A shape resolved onto one display, ready to send to that display's Overlay window. */
export interface ResolvedOverlayShape {
  displayId: number;
  shape: OverlayShape;
}

/**
 * Resolves a Shape Tag onto its display's Overlay window (M3-02), converting every
 * captured-pixel point into window-local logical pixels. The monitor is chosen by
 * {@link selectTargetScreen} - the same choice pointing makes, so a shape lands on the
 * screen the model tagged. Each defining point maps as a fraction of the captured frame
 * onto the display's bounds; because the Overlay window's origin is the display's bounds
 * origin, that fraction times the bounds size *is* the window-local coordinate (no
 * separate global step). A circle's radius is a horizontal length, so it scales by the
 * display's width ratio. Returns `null` only when there is no geometry to map against.
 */
export function resolveOverlayShape(
  shape: ParsedShape,
  geometry: DisplayCaptureGeometry[],
): ResolvedOverlayShape | null {
  const targetScreen = selectTargetScreen(shape.screenNumber, geometry);
  if (targetScreen === null) {
    return null;
  }

  const points = shape.points.map((point) => {
    const { fx, fy } = capturedFraction(targetScreen, point.x, point.y);
    return {
      localX: Math.round(fx * targetScreen.bounds.width),
      localY: Math.round(fy * targetScreen.bounds.height),
    };
  });

  const radius =
    shape.radius === null
      ? null
      : Math.round(
          targetScreen.capturedWidth > 0
            ? (shape.radius / targetScreen.capturedWidth) * targetScreen.bounds.width
            : 0,
        );

  return {
    displayId: targetScreen.displayId,
    shape: {
      kind: shape.kind,
      points,
      radius,
      label: shape.label,
      style: shape.style,
      step: shape.step,
    },
  };
}
