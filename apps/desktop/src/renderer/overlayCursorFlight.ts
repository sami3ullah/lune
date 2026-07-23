// The pure math behind the Overlay cursor's flight to a Point Tag target (ticket 07).
// The cursor doesn't slide in a straight line like a tooltip - it flies along a
// quadratic bezier arc, eased so it accelerates out and settles in, rotating to face
// its direction of travel and swelling at the apex for an energetic "swoop". Ported
// from v1's OverlayWindow bezier flight, kept as a pure function of progress so the
// React component only has to drive a clock and the feel is unit-testable.

/** A point in the Overlay window's local (top-left origin) coordinate space. */
export interface Point2D {
  x: number;
  y: number;
}

/** One rendered frame of the flight: where the cursor is, and how it is oriented. */
export interface FlightFrame {
  x: number;
  y: number;
  /** Degrees to rotate the triangle so its tip faces the direction of travel. */
  rotationDegrees: number;
  /** Scale multiplier - swells above 1 at the apex, 1 at both ends. */
  scale: number;
}

/** How far above the straight line the arc bows, as a fraction of the flight distance. */
const ARC_HEIGHT_FRACTION = 0.2;
/** Cap on the arc bow so a very long flight doesn't loop absurdly high. */
const MAX_ARC_HEIGHT = 80;
/** How much the cursor swells at the apex (1.3x at the midpoint). */
const APEX_SCALE_BOOST = 0.3;

/** Flight duration scales with distance, clamped so hops and long flights both read well. */
const MIN_FLIGHT_MS = 600;
const MAX_FLIGHT_MS = 1400;
const MS_PER_PIXEL = 1000 / 800;

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The quadratic bezier control point: the midpoint of the straight line, lifted
 * upward (smaller y, since the window's y grows downward) so the flight path bows
 * over the top rather than sliding flat. The lift grows with distance up to a cap.
 */
export function arcControlPoint(start: Point2D, end: Point2D): Point2D {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const distance = Math.hypot(deltaX, deltaY);
  const arcHeight = Math.min(distance * ARC_HEIGHT_FRACTION, MAX_ARC_HEIGHT);
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2 - arcHeight,
  };
}

/**
 * The flight frame at a given linear progress in `[0, 1]` (progress outside the range
 * is clamped so the cursor never extrapolates off the arc). Progress is smoothstep-
 * eased for an accelerate-out/settle-in feel; position follows the quadratic bezier;
 * rotation follows the curve's tangent (with the +90deg offset that aligns the
 * triangle's upward tip with rightward travel); scale pulses via a sine peaking at the
 * midpoint.
 */
export function flightFrameAt(
  start: Point2D,
  control: Point2D,
  end: Point2D,
  linearProgress: number,
): FlightFrame {
  const progress = clamp(linearProgress, 0, 1);

  // Smoothstep (3t^2 - 2t^3): eased position, so the cursor eases out of the start
  // and settles into the target rather than moving at a constant, mechanical speed.
  const eased = progress * progress * (3 - 2 * progress);
  const oneMinusEased = 1 - eased;

  const x =
    oneMinusEased * oneMinusEased * start.x +
    2 * oneMinusEased * eased * control.x +
    eased * eased * end.x;
  const y =
    oneMinusEased * oneMinusEased * start.y +
    2 * oneMinusEased * eased * control.y +
    eased * eased * end.y;

  // Tangent B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1); +90deg aligns the upward-pointing tip
  // with the direction of travel.
  const tangentX =
    2 * oneMinusEased * (control.x - start.x) + 2 * eased * (end.x - control.x);
  const tangentY =
    2 * oneMinusEased * (control.y - start.y) + 2 * eased * (end.y - control.y);
  const rotationDegrees = (Math.atan2(tangentY, tangentX) * 180) / Math.PI + 90;

  // Scale pulse: sine over linear progress peaks at the midpoint, 0 at both ends.
  const scale = 1 + Math.sin(progress * Math.PI) * APEX_SCALE_BOOST;

  return { x, y, rotationDegrees, scale };
}

/**
 * How long a flight of `distance` pixels should take: proportional to distance so a
 * short hop is quick and a long crossing is more dramatic, clamped to a sane range so
 * neither extreme feels wrong.
 */
export function flightDurationMs(distance: number): number {
  return clamp(distance * MS_PER_PIXEL, MIN_FLIGHT_MS, MAX_FLIGHT_MS);
}
