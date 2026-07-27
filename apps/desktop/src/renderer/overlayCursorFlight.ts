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

/**
 * How a flight's arc is shaped - the knob the Overlay randomizes per flight so no two
 * swoops trace the same path. Both values are multiples of the distance-derived arc
 * height, applied relative to the travel direction (so the shaping reads the same on a
 * short hop and a long crossing).
 */
export interface ArcShaping {
  /**
   * The bow, along the perpendicular to the travel direction. Negative bows "up" the
   * screen (the classic overhand swoop); positive bows the other way. Its magnitude sets
   * how pronounced the curve is.
   */
  perpendicular: number;
  /**
   * A skew along the travel direction that pushes the control point toward the start or
   * end, so the arc's crest sits early or late rather than always dead-centre. 0 is a
   * symmetric bow.
   */
  lateral: number;
}

/** The default bow: straight up and symmetric - the deterministic path the tests pin. */
export const DEFAULT_ARC_SHAPING: ArcShaping = { perpendicular: -1, lateral: 0 };

/**
 * Flight duration scales with distance, clamped so hops and long flights both read well.
 * Deliberately unhurried: the cursor gliding to its target is the user's cue for where to
 * look next, so it must be trackable by eye - a fast dart reads as the mark just appearing.
 */
const MIN_FLIGHT_MS = 550;
const MAX_FLIGHT_MS = 1900;
const MS_PER_PIXEL = 1000 / 850;

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The quadratic bezier control point that bends the flight into an arc: the midpoint of
 * the straight line, pushed off it by `shaping`. By default it lifts straight up (smaller
 * y, since the window's y grows downward) so the path bows over the top rather than
 * sliding flat; the Overlay passes a randomized `shaping` to vary the curve per flight.
 * The offset is expressed relative to the travel direction and grows with distance up to
 * a cap, so a short hop and a long crossing bow proportionally the same.
 */
export function arcControlPoint(
  start: Point2D,
  end: Point2D,
  shaping: ArcShaping = DEFAULT_ARC_SHAPING,
): Point2D {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const distance = Math.hypot(deltaX, deltaY);
  const arcHeight = Math.min(distance * ARC_HEIGHT_FRACTION, MAX_ARC_HEIGHT);

  // Unit travel direction and its perpendicular. The control point leaves the straight
  // line along the perpendicular (the bow) and may skew along the direction (the crest).
  const directionX = distance > 0 ? deltaX / distance : 0;
  const directionY = distance > 0 ? deltaY / distance : 0;
  const perpendicularX = -directionY;
  const perpendicularY = directionX;

  const midpointX = (start.x + end.x) / 2;
  const midpointY = (start.y + end.y) / 2;
  return {
    x: midpointX + perpendicularX * arcHeight * shaping.perpendicular + directionX * arcHeight * shaping.lateral,
    y: midpointY + perpendicularY * arcHeight * shaping.perpendicular + directionY * arcHeight * shaping.lateral,
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

// The following cursor's springy track (v1 parity). v1 followed the mouse with SwiftUI's
// `.spring(response: 0.2, dampingFraction: 0.6)`, which reads as a lively, slightly
// overshooting chase. The TS port originally used a per-frame linear ease, which both
// felt floaty (no momentum/overshoot) and was frame-rate dependent. These two constants
// + `springStep` reproduce the SwiftUI spring exactly and integrate against real elapsed
// time so the feel is identical whatever the frame rate.

/** How long one oscillation of the follow spring takes, in seconds (SwiftUI `response`). */
export const FOLLOW_SPRING_RESPONSE_SECONDS = 0.2;
/** The follow spring's damping ratio (SwiftUI `dampingFraction`); <1 gives a slight overshoot. */
export const FOLLOW_SPRING_DAMPING_FRACTION = 0.6;

/** One axis of a spring in motion: where it is and how fast it is moving. */
export interface SpringMotion {
  position: number;
  velocity: number;
}

/**
 * Advances one axis of a damped-harmonic-oscillator spring toward `target` over
 * `elapsedSeconds`, reproducing SwiftUI's `.spring(response:dampingFraction:)`.
 *
 * `response` maps to the spring's natural angular frequency (omega = 2*pi/response) and
 * `dampingFraction` is the damping ratio (zeta); the acceleration each instant is
 * `omega^2 * (target - position) - 2*zeta*omega*velocity`. It is integrated in fixed
 * tiny substeps so a long frame (a backgrounded window, a GC pause) can never make the
 * explicit integration overshoot and blow up, and so the motion is frame-rate independent.
 */
export function springStep(
  motion: SpringMotion,
  target: number,
  responseSeconds: number,
  dampingFraction: number,
  elapsedSeconds: number,
): SpringMotion {
  const angularFrequency = (2 * Math.PI) / responseSeconds;
  const dampingRatio = dampingFraction;

  // Cap the integrated span so a huge gap between frames settles the spring rather than
  // launching it, and substep so each integration step stays well inside the stable range.
  const MAX_INTEGRATION_SECONDS = 0.1;
  const MAX_SUBSTEP_SECONDS = 1 / 240;
  let position = motion.position;
  let velocity = motion.velocity;
  let remaining = clamp(elapsedSeconds, 0, MAX_INTEGRATION_SECONDS);
  while (remaining > 0) {
    const dt = Math.min(remaining, MAX_SUBSTEP_SECONDS);
    const acceleration =
      angularFrequency * angularFrequency * (target - position) -
      2 * dampingRatio * angularFrequency * velocity;
    // Semi-implicit Euler (velocity first) - stable for springs at these step sizes.
    velocity += acceleration * dt;
    position += velocity * dt;
    remaining -= dt;
  }
  return { position, velocity };
}
