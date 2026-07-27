import { describe, expect, it } from "vitest";
import {
  arcControlPoint,
  flightDurationMs,
  flightFrameAt,
  springStep,
  FOLLOW_SPRING_RESPONSE_SECONDS,
  FOLLOW_SPRING_DAMPING_FRACTION,
  type Point2D,
  type SpringMotion,
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

  it("shapes the bow: a positive perpendicular bows the other way, lateral skews the crest", () => {
    // Flipping the perpendicular sign bows below the line instead of above it.
    const bowedDown = arcControlPoint(START, END, { perpendicular: 1, lateral: 0 });
    expect(bowedDown.x).toBe(150);
    expect(bowedDown.y).toBeGreaterThan(0);
    // A lateral skew pushes the crest along the travel direction (off the midpoint).
    const skewed = arcControlPoint(START, END, { perpendicular: -1, lateral: 0.5 });
    expect(skewed.x).toBeGreaterThan(150);
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
    // Clamped so a tiny hop still reads as a flight and a huge one never drags. The
    // floor keeps even a short hop trackable by eye (the flight is the user's cue for
    // where to look next), and the ceiling keeps a cross-screen flight under ~3s.
    expect(shortHop).toBeGreaterThanOrEqual(500);
    expect(longFlight).toBeLessThanOrEqual(2000);
  });
});

describe("springStep (following-cursor spring)", () => {
  // Integrate the follow spring frame by frame at ~60fps toward a fixed target and
  // return the whole trajectory, mirroring how the RAF loop drives it.
  function settleTrajectory(target: number, frames: number): SpringMotion[] {
    let motion: SpringMotion = { position: 0, velocity: 0 };
    const trajectory: SpringMotion[] = [];
    for (let frame = 0; frame < frames; frame += 1) {
      motion = springStep(
        motion,
        target,
        FOLLOW_SPRING_RESPONSE_SECONDS,
        FOLLOW_SPRING_DAMPING_FRACTION,
        1 / 60,
      );
      trajectory.push(motion);
    }
    return trajectory;
  }

  it("moves toward the target and settles on it", () => {
    const trajectory = settleTrajectory(100, 120);
    const settled = trajectory[trajectory.length - 1];
    expect(settled.position).toBeCloseTo(100, 1);
    expect(settled.velocity).toBeCloseTo(0, 1);
  });

  it("overshoots slightly at this damping ratio (the lively v1 feel), then comes back", () => {
    // A damping fraction < 1 is under-damped, so the chase passes the target once.
    const peak = Math.max(...settleTrajectory(100, 120).map((motion) => motion.position));
    expect(peak).toBeGreaterThan(100);
    // But only a gentle overshoot, not a wild one.
    expect(peak).toBeLessThan(120);
  });

  it("is frame-rate independent: one big step lands near many small steps", () => {
    const manySmallSteps = settleTrajectory(100, 30);
    let oneBigStep: SpringMotion = { position: 0, velocity: 0 };
    for (let frame = 0; frame < 5; frame += 1) {
      // 30 frames at 1/60s each == 0.5s total; take it in 5 coarse 0.1s steps instead.
      oneBigStep = springStep(
        oneBigStep,
        100,
        FOLLOW_SPRING_RESPONSE_SECONDS,
        FOLLOW_SPRING_DAMPING_FRACTION,
        0.1,
      );
    }
    expect(oneBigStep.position).toBeCloseTo(manySmallSteps[manySmallSteps.length - 1].position, 0);
  });

  it("stays finite and settling even when a single frame is enormous (backgrounded tab)", () => {
    const afterHugeGap = springStep(
      { position: 0, velocity: 0 },
      100,
      FOLLOW_SPRING_RESPONSE_SECONDS,
      FOLLOW_SPRING_DAMPING_FRACTION,
      1000,
    );
    expect(Number.isFinite(afterHugeGap.position)).toBe(true);
    // The integrated span is capped, so it advances toward the target rather than exploding.
    expect(afterHugeGap.position).toBeGreaterThan(0);
    expect(afterHugeGap.position).toBeLessThanOrEqual(120);
  });
});
