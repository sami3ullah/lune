import { describe, expect, it } from "vitest";

import {
  applyRefinedBoxToShape,
  guessBoxForPoint,
  guessBoxForShape,
  planMarkCrop,
  refinedBoxIsPlausible,
  refinedPointFromBox,
} from "../src/main/overlay/markRefinement";
import type { ParsedShape } from "@lune/core";

/**
 * Unit tests for the Shell half of mark grounding refinement: the crop planned around a
 * mark's guess (native pixels) and the refined box applied back to the mark (captured
 * pixels). The scenario throughout mirrors the real bug: a 2560x1440 display whose model
 * image is 1430x804, so captured->native scale is ~1.79.
 */

const CAPTURED = { width: 1430, height: 804 };
const NATIVE = { width: 2560, height: 1440 };

function rectShape(x1: number, y1: number, x2: number, y2: number): ParsedShape {
  return {
    kind: "rect",
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
    radius: null,
    label: "book a demo button",
    style: { stroke: "solid", filled: false, color: null },
    screenNumber: null,
    step: null,
  };
}

describe("guessBoxForShape", () => {
  it("boxes a circle by its radius and a rect by its corners (order-normalized)", () => {
    const circle: ParsedShape = { ...rectShape(0, 0, 0, 0), kind: "circle", points: [{ x: 100, y: 80 }], radius: 30 };
    expect(guessBoxForShape(circle)).toEqual({ left: 70, top: 50, right: 130, bottom: 110 });
    expect(guessBoxForShape(rectShape(220, 104, 100, 60))).toEqual({
      left: 100,
      top: 60,
      right: 220,
      bottom: 104,
    });
  });

  it("declines the shapes whose points carry meaning a box can't recover", () => {
    const arrow: ParsedShape = { ...rectShape(10, 10, 50, 50), kind: "arrow" };
    expect(guessBoxForShape(arrow)).toBeNull();
    const zeroRadius: ParsedShape = { ...rectShape(0, 0, 0, 0), kind: "circle", points: [{ x: 5, y: 5 }], radius: 0 };
    expect(guessBoxForShape(zeroRadius)).toBeNull();
  });

  it("expands a point to a typical-control guess box", () => {
    expect(guessBoxForPoint({ x: 500, y: 300 })).toEqual({
      left: 470,
      top: 280,
      right: 530,
      bottom: 320,
    });
  });
});

describe("planMarkCrop", () => {
  it("scales the guess into native space and pads by the model-error budget", () => {
    const plan = planMarkCrop({ left: 860, top: 30, right: 890, bottom: 54 }, CAPTURED, NATIVE);
    expect(plan).not.toBeNull();
    const { crop, scale } = plan!;
    expect(scale).toBeCloseTo(2560 / 1430, 5);
    // The guess center in native space stays inside (and roughly centered in) the crop.
    const centerX = ((860 + 890) / 2) * scale;
    const centerY = ((30 + 54) / 2) * scale;
    expect(centerX).toBeGreaterThan(crop.x);
    expect(centerX).toBeLessThan(crop.x + crop.width);
    expect(centerY).toBeGreaterThan(crop.y);
    expect(centerY).toBeLessThan(crop.y + crop.height);
    // The error budget: 6% of the model image's larger dimension on each side, in native px.
    const pad = 0.06 * 1430 * scale;
    expect(crop.width).toBeGreaterThanOrEqual(Math.floor(2 * pad));
    // The anchor hint is the guess center in crop-relative pixels.
    expect(plan!.guessInCrop).toEqual({
      x: Math.round(centerX - crop.x),
      y: Math.round(centerY - crop.y),
    });
    // Fully inside the native capture.
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(NATIVE.width);
    expect(crop.y + crop.height).toBeLessThanOrEqual(NATIVE.height);
  });

  it("shifts (not shrinks) a crop that would spill past the capture's edge", () => {
    const nearCorner = planMarkCrop({ left: 2, top: 2, right: 20, bottom: 16 }, CAPTURED, NATIVE);
    expect(nearCorner).not.toBeNull();
    expect(nearCorner!.crop.x).toBe(0);
    expect(nearCorner!.crop.y).toBe(0);
    expect(nearCorner!.crop.width).toBeGreaterThanOrEqual(320);
    expect(nearCorner!.crop.height).toBeGreaterThanOrEqual(320);
  });

  it("returns null on degenerate geometry", () => {
    expect(planMarkCrop({ left: 0, top: 0, right: 10, bottom: 10 }, { width: 0, height: 0 }, NATIVE)).toBeNull();
  });
});

describe("refinedBoxIsPlausible", () => {
  const plan = { crop: { x: 0, y: 0, width: 640, height: 400 }, scale: 2, guessInCrop: { x: 320, y: 200 } };
  // A wide button guess, ~120x30 captured px.
  const guess = { left: 100, top: 60, right: 220, bottom: 90 };

  it("believes a box roughly the guess's own size", () => {
    // ~110x36 captured px (crop px halved by the scale).
    expect(refinedBoxIsPlausible(guess, { left: 180, top: 100, right: 400, bottom: 172 }, plan, true)).toBe(true);
  });

  it("rejects a box wildly larger than the guess (a boxed illustration)", () => {
    // ~300x300 captured px vs a 120x30 guess: ~25x the area.
    expect(refinedBoxIsPlausible(guess, { left: 20, top: 20, right: 620, bottom: 380 }, plan, true)).toBe(false);
  });

  it("believes anything for a point's synthetic guess box (no size prior)", () => {
    expect(refinedBoxIsPlausible(guess, { left: 20, top: 20, right: 620, bottom: 380 }, plan, false)).toBe(true);
  });
});

describe("applying a refined box", () => {
  it("round-trips crop pixels back to captured pixels for a rect", () => {
    const plan = { crop: { x: 1400, y: 0, width: 640, height: 400 }, scale: 2560 / 1430, guessInCrop: { x: 320, y: 200 } };
    // The element in crop space; in native space it spans (1500,100)-(1720,152).
    const refined = { left: 100, top: 100, right: 320, bottom: 152 };
    const applied = applyRefinedBoxToShape(rectShape(0, 0, 0, 0), refined, plan, CAPTURED);
    // native -> captured divides by scale; margin of 6 captured px is added around it.
    expect(applied.points[0]!.x).toBe(Math.round(1500 / plan.scale) - 6);
    expect(applied.points[0]!.y).toBe(Math.round(100 / plan.scale) - 6);
    expect(applied.points[1]!.x).toBe(Math.round(1720 / plan.scale) + 6);
    expect(applied.points[1]!.y).toBe(Math.round(152 / plan.scale) + 6);
    expect(applied.label).toBe("book a demo button");
    expect(applied.kind).toBe("rect");
  });

  it("re-centers a circle on the element with a radius that just encloses it", () => {
    const plan = { crop: { x: 0, y: 0, width: 640, height: 400 }, scale: 2, guessInCrop: { x: 320, y: 200 } };
    const circle: ParsedShape = {
      ...rectShape(0, 0, 0, 0),
      kind: "circle",
      points: [{ x: 10, y: 10 }],
      radius: 20,
    };
    const applied = applyRefinedBoxToShape(circle, { left: 100, top: 100, right: 200, bottom: 140 }, plan, CAPTURED);
    expect(applied.points).toEqual([{ x: 75, y: 60 }]);
    // Larger element dimension is 100 crop px = 50 captured px -> radius 25 + margin 8.
    expect(applied.radius).toBe(33);
  });

  it("lands a refined point on the element's center", () => {
    const plan = { crop: { x: 200, y: 100, width: 640, height: 400 }, scale: 2, guessInCrop: { x: 320, y: 200 } };
    expect(refinedPointFromBox({ left: 100, top: 100, right: 200, bottom: 140 }, plan)).toEqual({
      x: (200 + 150) / 2,
      y: (100 + 120) / 2,
    });
  });
});
