import { describe, expect, it } from "vitest";
import type { ParsedShape } from "@lune/core";
import {
  luminanceImageFromBitmap,
  snapPointToElement,
  snapShapeToElement,
  type SnapImage,
} from "../src/main/overlay/elementSnap";

// Element snapping (the drawing-accuracy fix): the model names the right button but
// misses its pixels by 20-40px, so marks are snapped onto the visually-distinct element
// nearest the guess - and left alone when nothing is convincingly there. These tests
// draw synthetic "buttons" (bordered boxes with text-ish specks on a plain background)
// and offset the guess exactly the way the real bug reports showed (a mark ~35px off,
// above or below its button).

/** A synthetic screenshot: a light background to draw dark elements onto. */
function makeImage(width: number, height: number, background = 235): SnapImage {
  const luminance = new Uint8ClampedArray(width * height).fill(background);
  return { width, height, luminance };
}

/** An element's box, edges inclusive (the ground truth the snapper should recover). */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Draws a button: a 2px dark border plus a few text-like strokes inside. */
function drawButton(image: SnapImage, box: Box, value = 40): void {
  const setPixel = (x: number, y: number): void => {
    if (x >= 0 && x < image.width && y >= 0 && y < image.height) {
      image.luminance[y * image.width + x] = value;
    }
  };
  for (let x = box.left; x <= box.right; x += 1) {
    for (const y of [box.top, box.top + 1, box.bottom - 1, box.bottom]) {
      setPixel(x, y);
    }
  }
  for (let y = box.top; y <= box.bottom; y += 1) {
    for (const x of [box.left, box.left + 1, box.right - 1, box.right]) {
      setPixel(x, y);
    }
  }
  // Text-ish strokes across the middle, inset from the border.
  const textY = Math.round((box.top + box.bottom) / 2);
  for (let x = box.left + 8; x <= box.right - 8; x += 3) {
    setPixel(x, textY);
    setPixel(x, textY + 1);
  }
}

function circleShape(x: number, y: number, radius: number): ParsedShape {
  return {
    kind: "circle",
    points: [{ x, y }],
    radius,
    label: "book a demo",
    style: { stroke: "solid", filled: false, color: null },
    screenNumber: null,
    step: 1,
  };
}

function rectShape(x1: number, y1: number, x2: number, y2: number): ParsedShape {
  return {
    kind: "rect",
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
    radius: null,
    label: "book a demo",
    style: { stroke: "solid", filled: false, color: null },
    screenNumber: null,
    step: 1,
  };
}

/** The box a snapped rect's two points span. */
function snappedBox(shape: ParsedShape): Box {
  const [a, b] = shape.points;
  return {
    left: Math.min(a!.x, b!.x),
    top: Math.min(a!.y, b!.y),
    right: Math.max(a!.x, b!.x),
    bottom: Math.max(a!.y, b!.y),
  };
}

describe("luminanceImageFromBitmap", () => {
  it("averages the three color channels of 4-byte pixels", () => {
    // Two pixels: near-black and pure white (alpha ignored).
    const bitmap = new Uint8Array([10, 20, 30, 255, 255, 255, 255, 0]);
    const image = luminanceImageFromBitmap(bitmap, 2, 1);
    expect(image.luminance[0]).toBe(20);
    expect(image.luminance[1]).toBe(255);
  });
});

describe("snapShapeToElement", () => {
  // The real bug reports: the button sits at one spot, the mark landed ~35px away.
  const BUTTON: Box = { left: 200, top: 130, right: 330, bottom: 168 };

  it("moves a rect guessed below the button (bug report 1) onto the button", () => {
    const image = makeImage(640, 400);
    drawButton(image, BUTTON);
    // The model's box: right size, ~35px too low and a little left.
    const snapped = snapShapeToElement(rectShape(185, 165, 315, 203), image);

    const box = snappedBox(snapped);
    // Hugs the button with the small breathing margin (6px).
    expect(box.left).toBe(BUTTON.left - 6);
    expect(box.top).toBe(BUTTON.top - 6);
    expect(box.right).toBe(BUTTON.right + 6);
    expect(box.bottom).toBe(BUTTON.bottom + 6);
  });

  it("moves a circle guessed above the button (bug report 2) onto the button", () => {
    const image = makeImage(640, 400);
    drawButton(image, BUTTON);
    // The model's ring: centered ~38px above and left of the button's center.
    const guessed = circleShape(230, 110, 40);
    const snapped = snapShapeToElement(guessed, image);

    const center = snapped.points[0]!;
    expect(center.x).toBe(Math.round((BUTTON.left + BUTTON.right) / 2));
    expect(center.y).toBe(Math.round((BUTTON.top + BUTTON.bottom) / 2));
    // The ring encloses the button (half its larger dimension plus the margin).
    const buttonWidth = BUTTON.right - BUTTON.left + 1;
    expect(snapped.radius).toBe(Math.round(buttonWidth / 2 + 8));
  });

  it("keeps the label, step, and style of a snapped shape", () => {
    const image = makeImage(640, 400);
    drawButton(image, BUTTON);
    const snapped = snapShapeToElement(rectShape(185, 165, 315, 203), image);

    expect(snapped.kind).toBe("rect");
    expect(snapped.label).toBe("book a demo");
    expect(snapped.step).toBe(1);
    expect(snapped.style).toEqual({ stroke: "solid", filled: false, color: null });
  });

  it("snaps to the button the guess overlaps most when two sit side by side", () => {
    const image = makeImage(640, 400);
    const bookADemo: Box = { left: 200, top: 130, right: 330, bottom: 168 };
    const signUp: Box = { left: 346, top: 130, right: 440, bottom: 168 };
    drawButton(image, bookADemo);
    drawButton(image, signUp);
    // Guess offset upward but clearly over "book a demo", not "sign up".
    const snapped = snapShapeToElement(rectShape(195, 100, 325, 140), image);

    const box = snappedBox(snapped);
    expect(box.left).toBe(bookADemo.left - 6);
    expect(box.right).toBe(bookADemo.right + 6);
  });

  it("leaves the shape unchanged on a blank region (nothing to snap to)", () => {
    const image = makeImage(640, 400);
    const guessed = rectShape(185, 165, 315, 203);
    expect(snapShapeToElement(guessed, image)).toEqual(guessed);
  });

  it("leaves the shape unchanged on uniform busy texture (no distinct element)", () => {
    const image = makeImage(640, 400);
    // A dense checkerboard: edges everywhere, so the region is one giant blob - which
    // must be rejected as background structure rather than snapped to.
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        image.luminance[y * image.width + x] = (x + y) % 2 === 0 ? 30 : 220;
      }
    }
    const guessed = rectShape(185, 165, 315, 203);
    expect(snapShapeToElement(guessed, image)).toEqual(guessed);
  });

  it("does not teleport a button-shaped guess onto a dissimilar nearby graphic", () => {
    const image = makeImage(640, 400);
    // No button anywhere near the guess - only a square illustration below it (the
    // ElevenLabs "Provenance" circles bug): close enough for a proximity rescue, but
    // nothing like the wide, short box the model described.
    drawButton(image, { left: 220, top: 167, right: 310, bottom: 257 });
    const guessed = rectShape(200, 130, 330, 160);
    expect(snapShapeToElement(guessed, image)).toEqual(guessed);
  });

  it("ignores an edge cluster vastly larger than the guess (a page frame)", () => {
    const image = makeImage(640, 400);
    // A huge content frame around most of the page - the only edges near the guess.
    drawButton(image, { left: 20, top: 20, right: 620, bottom: 380 });
    const guessed = rectShape(300, 190, 340, 210);
    expect(snapShapeToElement(guessed, image)).toEqual(guessed);
  });

  it("never snaps arrows or lines (their endpoints carry meaning)", () => {
    const image = makeImage(640, 400);
    drawButton(image, BUTTON);
    const arrow: ParsedShape = {
      kind: "arrow",
      points: [
        { x: 100, y: 100 },
        { x: 250, y: 160 },
      ],
      radius: null,
      label: "drag here",
      style: { stroke: "solid", filled: false, color: null },
      screenNumber: null,
      step: null,
    };
    expect(snapShapeToElement(arrow, image)).toEqual(arrow);
  });

  it("leaves a degenerate circle (no radius) unchanged", () => {
    const image = makeImage(640, 400);
    drawButton(image, BUTTON);
    const degenerate: ParsedShape = { ...circleShape(230, 110, 0), radius: null };
    expect(snapShapeToElement(degenerate, image)).toEqual(degenerate);
  });
});

describe("snapPointToElement", () => {
  const BUTTON: Box = { left: 200, top: 130, right: 330, bottom: 168 };

  it("lands a near-miss point on the button's center", () => {
    const image = makeImage(640, 400);
    drawButton(image, BUTTON);
    // The model pointed just above the button.
    const snapped = snapPointToElement({ x: 255, y: 112 }, image);
    expect(snapped).toEqual({
      x: Math.round((BUTTON.left + BUTTON.right) / 2),
      y: Math.round((BUTTON.top + BUTTON.bottom) / 2),
    });
  });

  it("returns null on a blank region so the caller keeps the model's point", () => {
    const image = makeImage(640, 400);
    expect(snapPointToElement({ x: 255, y: 112 }, image)).toBeNull();
  });
});
