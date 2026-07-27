import { describe, expect, it } from "vitest";
import {
  computeIntroCardTarget,
  type IntroCardPlacementInput,
} from "../src/renderer/introVideoPlacement";

// The pure placement math behind the cursor-riding intro video (M3-03): the card rides
// alongside the pointer and is kept clear of the onboarding window, so "never obscures the
// onboarding UI" is a tested guarantee rather than something only visible by eye.

const CARD = { width: 400, height: 600 };
const DISPLAY = { width: 1600, height: 1000 };
// A 560x640 onboarding window centred on the display (the real first-run size).
const CENTERED_WIZARD = {
  x: (DISPLAY.width - 560) / 2,
  y: (DISPLAY.height - 640) / 2,
  width: 560,
  height: 640,
};

function place(overrides: Partial<IntroCardPlacementInput>): { x: number; y: number } {
  return computeIntroCardTarget({
    cursor: { x: 800, y: 500 },
    cardSize: CARD,
    displaySize: DISPLAY,
    avoidRect: null,
    gap: 24,
    margin: 24,
    ...overrides,
  });
}

/** The card rectangle at a placement, for overlap assertions. */
function cardRect(target: { x: number; y: number }) {
  return { x: target.x, y: target.y, width: CARD.width, height: CARD.height };
}

/** True when two rectangles overlap at all. */
function overlaps(a: ReturnType<typeof cardRect>, b: typeof CENTERED_WIZARD): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

describe("computeIntroCardTarget", () => {
  it("centres the card vertically on the cursor", () => {
    const target = place({ cursor: { x: 800, y: 500 } });
    expect(target.y).toBe(500 - CARD.height / 2);
  });

  it("rides beside the cursor at the gap when there is room (no wizard to avoid)", () => {
    // Cursor left-of-centre: more room on the right, so the card sits to its right.
    const rightSide = place({ cursor: { x: 400, y: 500 } });
    expect(rightSide.x).toBe(400 + 24);
    // Cursor right-of-centre: more room on the left, so it flips to the left.
    const leftSide = place({ cursor: { x: 1200, y: 500 } });
    expect(leftSide.x).toBe(1200 - 24 - CARD.width);
  });

  it("keeps the card fully on-screen against every edge", () => {
    const topLeft = place({ cursor: { x: 5, y: 5 } });
    expect(topLeft.x).toBeGreaterThanOrEqual(24);
    expect(topLeft.y).toBe(24);

    const bottomRight = place({ cursor: { x: 1595, y: 995 } });
    expect(bottomRight.x).toBeLessThanOrEqual(DISPLAY.width - CARD.width - 24);
    expect(bottomRight.y).toBe(DISPLAY.height - CARD.height - 24);
  });

  it("never overlaps a centred onboarding window, wherever the cursor is over it", () => {
    // Sweep the cursor across the whole wizard; the card must stay clear at every step.
    for (let x = CENTERED_WIZARD.x; x <= CENTERED_WIZARD.x + CENTERED_WIZARD.width; x += 40) {
      const target = place({ cursor: { x, y: 500 }, avoidRect: CENTERED_WIZARD });
      expect(overlaps(cardRect(target), CENTERED_WIZARD)).toBe(false);
    }
  });

  it("dodges to the side of the cursor away from the wizard", () => {
    // Cursor on the wizard's left half -> the card goes left, clear of the window.
    const leftTarget = place({ cursor: { x: CENTERED_WIZARD.x + 60, y: 500 }, avoidRect: CENTERED_WIZARD });
    expect(leftTarget.x + CARD.width).toBeLessThanOrEqual(CENTERED_WIZARD.x);

    // Cursor on the wizard's right half -> the card goes right, clear of the window.
    const rightTarget = place({
      cursor: { x: CENTERED_WIZARD.x + CENTERED_WIZARD.width - 60, y: 500 },
      avoidRect: CENTERED_WIZARD,
    });
    expect(rightTarget.x).toBeGreaterThanOrEqual(CENTERED_WIZARD.x + CENTERED_WIZARD.width);
  });

  it("falls back to the least-obscuring side when the display can't fully clear the wizard", () => {
    // A narrow display where a centred wizard leaves neither side wide enough for the card:
    // the overlap can't reach zero, but the card still avoids sitting centred on the window.
    const narrow = { width: 1100, height: 1000 };
    const wizard = { x: (narrow.width - 560) / 2, y: 180, width: 560, height: 640 };
    const target = computeIntroCardTarget({
      cursor: { x: narrow.width / 2, y: 500 },
      cardSize: CARD,
      displaySize: narrow,
      avoidRect: wizard,
      gap: 24,
      margin: 24,
    });
    // Pinned to an edge margin (the roomier side), not floating over the wizard's centre.
    expect(target.x === 24 || target.x === narrow.width - CARD.width - 24).toBe(true);
  });
});
