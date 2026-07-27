import { describe, expect, it } from "vitest";
import type { ParsedShape } from "@lune/core";
import { resolveOverlayShape, type DisplayCaptureGeometry } from "../src/main/overlay/overlayGeometry";
import { planShapeMessages } from "../src/main/overlay/overlayShapes";

// The teaching-overlay shape routing (M3-02): resolving a model's Shape Tag onto the right
// monitor in window-local pixels, and grouping a turn's shapes into one draw-shapes event
// per display. The pure half of "shapes render precisely at their coordinates on the
// correct monitor".

const TWO_DISPLAY_GEOMETRY: DisplayCaptureGeometry[] = [
  {
    screenNumber: 1,
    displayId: 100,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    // Captured at half size, so captured-pixel coords are half the logical bounds.
    capturedWidth: 720,
    capturedHeight: 450,
  },
  {
    screenNumber: 2,
    displayId: 200,
    bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
    capturedWidth: 1920,
    capturedHeight: 1080,
  },
];

function circle(overrides: Partial<ParsedShape> = {}): ParsedShape {
  return {
    kind: "circle",
    points: [{ x: 360, y: 225 }],
    radius: 50,
    label: "save button",
    style: { stroke: "solid", filled: false, color: null },
    screenNumber: null,
    ...overrides,
  };
}

describe("resolveOverlayShape", () => {
  it("maps a circle's center and radius into window-local pixels on the cursor's screen", () => {
    // Captured 720x450 -> logical 1440x900 is a 2x scale: center doubles, radius doubles.
    const resolved = resolveOverlayShape(circle(), TWO_DISPLAY_GEOMETRY);
    expect(resolved).toEqual({
      displayId: 100,
      shape: {
        kind: "circle",
        points: [{ localX: 720, localY: 450 }],
        radius: 100,
        label: "save button",
        style: { stroke: "solid", filled: false, color: null },
      },
    });
  });

  it("maps a two-point shape onto the tagged monitor, local to that window", () => {
    const arrow: ParsedShape = {
      kind: "arrow",
      points: [
        { x: 0, y: 0 },
        { x: 960, y: 540 },
      ],
      radius: null,
      label: "from a to b",
      style: { stroke: "dashed", filled: false, color: "red" },
      screenNumber: 2,
    };
    const resolved = resolveOverlayShape(arrow, TWO_DISPLAY_GEOMETRY);
    // Display 200 is captured 1:1, so local coords equal captured coords (window origin
    // is the display's bounds origin, so no bounds.x offset appears).
    expect(resolved).toEqual({
      displayId: 200,
      shape: {
        kind: "arrow",
        points: [
          { localX: 0, localY: 0 },
          { localX: 960, localY: 540 },
        ],
        radius: null,
        label: "from a to b",
        style: { stroke: "dashed", filled: false, color: "red" },
      },
    });
  });

  it("clamps an out-of-frame coordinate to the display edge", () => {
    const resolved = resolveOverlayShape(circle({ points: [{ x: 9999, y: -50 }], radius: 0 }), TWO_DISPLAY_GEOMETRY);
    expect(resolved!.shape.points).toEqual([{ localX: 1440, localY: 0 }]);
  });

  it("returns null when there is no geometry to map against", () => {
    expect(resolveOverlayShape(circle(), [])).toBeNull();
  });
});

describe("planShapeMessages", () => {
  it("returns nothing when the answer draws no shapes", () => {
    expect(planShapeMessages([], TWO_DISPLAY_GEOMETRY)).toEqual([]);
  });

  it("groups a turn's shapes into one draw-shapes event per display, in order", () => {
    const shapes: ParsedShape[] = [
      circle({ label: "one", screenNumber: 1 }),
      circle({ label: "two", screenNumber: 2, points: [{ x: 960, y: 540 }], radius: 100 }),
      circle({ label: "three", screenNumber: 1, points: [{ x: 0, y: 0 }], radius: 10 }),
    ];
    const messages = planShapeMessages(shapes, TWO_DISPLAY_GEOMETRY);
    // Two displays touched: 100 (screens one + three) and 200 (screen two), first-seen order.
    expect(messages.map((message) => message.displayId)).toEqual([100, 200]);
    expect(messages[0]!.event.type).toBe("draw-shapes");
    const first = messages[0]!.event;
    if (first.type !== "draw-shapes") throw new Error("expected draw-shapes");
    expect(first.shapes.map((shape) => shape.label)).toEqual(["one", "three"]);
    const second = messages[1]!.event;
    if (second.type !== "draw-shapes") throw new Error("expected draw-shapes");
    expect(second.shapes.map((shape) => shape.label)).toEqual(["two"]);
  });
});
