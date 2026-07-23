import { z } from "zod";

// The Pill's placement is expressed entirely through one anchor: the top-center
// point of the pill on screen. It is the invariant the whole surface pivots on -
// the menu grows downward from it on hover (so it must stay put as the window
// resizes), and it is the single value persisted across restarts (ticket 04). All
// of this is pure geometry, kept free of Electron so it can be unit-tested at the
// highest seam and reused unchanged by a future Windows shell.

/** The top-center point of the pill in global screen coordinates. */
export interface PillAnchor {
  x: number;
  y: number;
}

/** A window size in logical pixels. */
export interface PillSize {
  width: number;
  height: number;
}

/** A window rectangle in global screen coordinates (Electron's bounds shape). */
export interface PillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A display's usable area - the screen minus the menu bar/notch and dock. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, lowerBound: number, upperBound: number): number {
  return Math.min(Math.max(value, lowerBound), upperBound);
}

/**
 * The window bounds that place a window of `size` with its top-center at `anchor`.
 * Because the anchor is the top-center, growing the window (collapsed -> expanded
 * menu) keeps the pill visually fixed while the menu unfolds below it.
 */
export function boundsForAnchor(anchor: PillAnchor, size: PillSize): PillRect {
  return {
    x: Math.round(anchor.x - size.width / 2),
    y: Math.round(anchor.y),
    width: size.width,
    height: size.height,
  };
}

/** Recovers the top-center anchor from window bounds - the inverse of {@link boundsForAnchor}. */
export function anchorFromBounds(bounds: PillRect): PillAnchor {
  return { x: bounds.x + bounds.width / 2, y: bounds.y };
}

/**
 * The out-of-box position: top-center of a display's work area, `topMargin` below
 * the menu bar/notch. The work area already excludes the menu bar (taller on a
 * notch Mac), so the same computation lands correctly on notch and non-notch
 * displays and on external monitors (user story 16).
 */
export function defaultAnchor(workArea: WorkArea, topMargin: number): PillAnchor {
  return {
    x: workArea.x + workArea.width / 2,
    y: workArea.y + topMargin,
  };
}

/**
 * Confines an anchor so a window of `size` stays fully within `workArea` - the
 * pill can be dragged anywhere but never off-screen or under the menu bar, so it
 * can always be grabbed again after a restart or a display reconfiguration.
 */
export function clampAnchor(anchor: PillAnchor, size: PillSize, workArea: WorkArea): PillAnchor {
  const halfWidth = size.width / 2;
  return {
    x: clamp(anchor.x, workArea.x + halfWidth, workArea.x + workArea.width - halfWidth),
    y: clamp(anchor.y, workArea.y, workArea.y + workArea.height - size.height),
  };
}

// A persisted anchor is only trustworthy if both coordinates are real finite
// numbers; anything else (a truncated write, a hand-edited file, a schema drift)
// falls back to the default position rather than placing the pill at NaN.
const PillAnchorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

/**
 * Validates a value read back from the persisted position file, returning a clean
 * {@link PillAnchor} or `null` when it is malformed so the caller can fall back to
 * {@link defaultAnchor}.
 */
export function parsePillAnchor(raw: unknown): PillAnchor | null {
  const parsed = PillAnchorSchema.safeParse(raw);
  return parsed.success ? { x: parsed.data.x, y: parsed.data.y } : null;
}
