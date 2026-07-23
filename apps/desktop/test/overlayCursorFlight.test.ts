import { describe, expect, it } from "vitest";
import {
  arcControlPoint,
  flightDurationMs,
  flightFrameAt,
  type Point2D,
} from "../src/renderer/overlayCursorFlight";

// The pure math behind the cursor's flight to a Point Tag target: a quadratic bezier
// arc with eased progress, the triangle rotating to face its travel direction and
// pulsing larger at the apex. Keeping it pure (the React component just feeds it a
// clock) is what makes "the cursor's movement feels alive - bezier arcs, easing" a
// tested guarantee rather than an animation nobody can assert on.

const START: Point2D = { x: 0, y: 0 };
const END: Point2D = { x: 300, y: 0 };

describe("arcControlPoint", () => {
  it("lifts the control point above the straight line so the path arcs, not slides", () => {
    const control = arcControlPoint(START, END);
    // Midpoint horizontally, lifted upward (smaller y) so the flight bows over the top.
    expect(control.x).toBe(150);
    expect(control.y).toBeLessThan(0);
  });
});

describe("flightFrameAt", () => {
  const control = arcControlPoint(START, END);

  it("sits exactly at the start when progress is 0", () => {
    const frame = flightFrameAt(START, control, END, 0);
    expect(frame.x).toBeCloseTo(0);
    expect(frame.y).toBeCloseTo(0);
    expect(frame.scale).toBeCloseTo(1);
  });

  it("lands exactly at the end when progress is 1", () => {
    const frame = flightFrameAt(START, control, END, 1);
    expect(frame.x).toBeCloseTo(300);
    expect(frame.y).toBeCloseTo(0);
    expect(frame.scale).toBeCloseTo(1);
  });

  it("bows above the straight line at the midpoint of the flight", () => {
    const frame = flightFrameAt(START, control, END, 0.5);
    expect(frame.x).toBeCloseTo(150);
    // Above the y=0 line the two endpoints share.
    expect(frame.y).toBeLessThan(0);
  });

  it("swells the cursor at the apex and returns to normal size at the ends", () => {
    const midpoint = flightFrameAt(START, control, END, 0.5);
    expect(midpoint.scale).toBeGreaterThan(1);
    expect(flightFrameAt(START, control, END, 0).scale).toBeCloseTo(1);
    expect(flightFrameAt(START, control, END, 1).scale).toBeCloseTo(1);
  });

  it("faces its direction of travel (roughly rightward on a left-to-right arc)", () => {
    // Partway along a rightward arc the tangent points right-ish; the triangle's tip
    // (pointing up at 0deg) is rotated ~+90deg to align with rightward travel.
    const frame = flightFrameAt(START, control, END, 0.5);
    expect(frame.rotationDegrees).toBeGreaterThan(45);
    expect(frame.rotationDegrees).toBeLessThan(135);
  });

  it("clamps progress outside [0,1] rather than extrapolating off the arc", () => {
    expect(flightFrameAt(START, control, END, -1).x).toBeCloseTo(0);
    expect(flightFrameAt(START, control, END, 2).x).toBeCloseTo(300);
  });
});

describe("flightDurationMs", () => {
  it("makes longer flights take longer, within sane bounds", () => {
    const shortHop = flightDurationMs(50);
    const longFlight = flightDurationMs(3000);
    expect(longFlight).toBeGreaterThan(shortHop);
    // Clamped so a tiny hop still reads as a flight and a huge one never drags.
    expect(shortHop).toBeGreaterThanOrEqual(600);
    expect(longFlight).toBeLessThanOrEqual(1400);
  });
});
