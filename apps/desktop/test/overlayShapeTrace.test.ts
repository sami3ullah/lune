import { describe, expect, it } from "vitest";
import {
  buildOutline,
  outlineToPathData,
  penTraceVisibility,
  sampleOutline,
  shapesBounds,
  traceDurationMs,
  type TraceableShape,
} from "../src/renderer/overlayShapeTrace";

// The pure geometry behind "the cursor draws the teaching shapes": outlining a shape into
// polyline segments, sampling a point along that outline by painted-length fraction, and
// emitting the matching SVG path. Kept pure (the React component feeds it a clock) so the
// cursor-tip/stroke-draw-on sync is a tested guarantee, exactly like overlayCursorFlight.

const LINE: TraceableShape = { kind: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], radius: null };

describe("sampleOutline on a straight line", () => {
  const outline = buildOutline(LINE);

  it("sits at the start at t=0 and the end at t=1", () => {
    expect(sampleOutline(outline, 0)).toMatchObject({ x: 0, y: 0 });
    expect(sampleOutline(outline, 1)).toMatchObject({ x: 100, y: 0 });
  });

  it("is halfway along at t=0.5, facing its direction of travel (+90 tip convention)", () => {
    const mid = sampleOutline(outline, 0.5);
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(0);
    // A rightward edge: tip (up at 0deg) rotates +90 to face right.
    expect(mid.rotationDegrees).toBeCloseTo(90);
  });

  it("clamps t outside [0,1] rather than running off the outline", () => {
    expect(sampleOutline(outline, -1).x).toBeCloseTo(0);
    expect(sampleOutline(outline, 2).x).toBeCloseTo(100);
  });
});

describe("buildOutline geometry", () => {
  it("outlines a circle as a closed ring whose length is ~2*pi*r", () => {
    const outline = buildOutline({ kind: "circle", points: [{ x: 50, y: 50 }], radius: 40 });
    expect(outline.segments).toHaveLength(1);
    expect(outline.segments[0]!.closed).toBe(true);
    // A 64-gon slightly under-measures the true circumference; within ~1%.
    expect(outline.totalLength).toBeGreaterThan(2 * Math.PI * 40 * 0.98);
    expect(outline.totalLength).toBeLessThanOrEqual(2 * Math.PI * 40);
    // Every sampled point sits on the ring (radius 40 from the centre).
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const p = sampleOutline(outline, t);
      expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(40, 0);
    }
  });

  it("outlines a rectangle as one closed perimeter through its four corners", () => {
    const outline = buildOutline({
      kind: "rect",
      points: [{ x: 0, y: 0 }, { x: 200, y: 100 }],
      radius: null,
    });
    expect(outline.segments).toHaveLength(1);
    expect(outline.segments[0]!.closed).toBe(true);
    // Perimeter of a 200x100 box.
    expect(outline.totalLength).toBeCloseTo(600, 4);
  });

  it("outlines a polygon as one closed loop through its vertices", () => {
    const outline = buildOutline({
      kind: "polygon",
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }],
      radius: null,
    });
    expect(outline.segments).toHaveLength(1);
    expect(outline.segments[0]!.closed).toBe(true);
    // Perimeter = the three edges of the closed triangle.
    const expected = 100 + Math.hypot(50, 80) + Math.hypot(50, 80);
    expect(outline.totalLength).toBeCloseTo(expected, 4);
  });

  it("returns an empty outline for a degenerate shape (too few points / zero radius)", () => {
    expect(buildOutline({ kind: "polygon", points: [{ x: 0, y: 0 }], radius: null }).totalLength).toBe(0);
    expect(buildOutline({ kind: "circle", points: [{ x: 0, y: 0 }], radius: 0 }).totalLength).toBe(0);
    // A zero-length outline samples to its origin, facing rest.
    expect(sampleOutline(buildOutline({ kind: "circle", points: [], radius: null }), 0.5)).toEqual({
      x: 0,
      y: 0,
      rotationDegrees: 0,
    });
  });
});

describe("outlineToPathData", () => {
  it("emits a moveto per segment (the zero-length pen-lift) and closes closed segments", () => {
    const rect = outlineToPathData(
      buildOutline({ kind: "rect", points: [{ x: 0, y: 0 }, { x: 200, y: 100 }], radius: null }),
    );
    // A closed perimeter -> one moveto and a Z.
    expect(rect.match(/M/g)).toHaveLength(1);
    expect(rect).toContain("Z");

    // An arrow -> shaft + head, two movetos (a pen-lift between), open (no Z).
    const arrow = outlineToPathData(
      buildOutline({ kind: "arrow", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], radius: null }),
    );
    expect(arrow.match(/M/g)).toHaveLength(2);
    expect(arrow).not.toContain("Z");

    const polygon = outlineToPathData(
      buildOutline({ kind: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }], radius: null }),
    );
    expect(polygon.match(/M/g)).toHaveLength(1);
    expect(polygon).toContain("Z");
  });
});

describe("traceDurationMs", () => {
  it("makes longer outlines take longer to draw, within sane bounds", () => {
    expect(traceDurationMs(2000)).toBeGreaterThan(traceDurationMs(50));
    // The floor keeps even a tiny ring visibly hand-drawn (not blinked on); the
    // ceiling keeps a screen-spanning outline under ~3s.
    expect(traceDurationMs(50)).toBeGreaterThanOrEqual(500);
    expect(traceDurationMs(5000)).toBeLessThanOrEqual(2000);
  });
});

describe("penTraceVisibility", () => {
  it("hides the stroke until the pen has actually started drawing", () => {
    // At progress 0 a round-capped SVG path still paints a dot at the outline's start
    // (a zero-length dash gets its caps), and the pen mounts while the cursor is still
    // flying in - a visible stroke there is a mark at a spot the cursor hasn't reached.
    expect(penTraceVisibility(0)).toBe("hidden");
    expect(penTraceVisibility(0.001)).toBe("visible");
    expect(penTraceVisibility(0.5)).toBe("visible");
    expect(penTraceVisibility(1)).toBe("visible");
  });
});

describe("shapesBounds", () => {
  it("encloses a circle's full radius and pads on every side", () => {
    const bounds = shapesBounds([{ kind: "circle", points: [{ x: 100, y: 100 }], radius: 20 }], 10);
    expect(bounds).toEqual({ x: 70, y: 70, width: 60, height: 60 });
  });

  it("unions several shapes into one box and returns null for nothing", () => {
    const bounds = shapesBounds([
      { kind: "line", points: [{ x: 0, y: 0 }, { x: 50, y: 10 }], radius: null },
      { kind: "line", points: [{ x: 30, y: -20 }, { x: 80, y: 40 }], radius: null },
    ]);
    expect(bounds).toEqual({ x: 0, y: -20, width: 80, height: 60 });
    expect(shapesBounds([])).toBeNull();
  });
});
