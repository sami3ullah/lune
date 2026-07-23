import { describe, expect, it } from "vitest";
import {
  anchorFromBounds,
  boundsForAnchor,
  clampAnchor,
  defaultAnchor,
  parsePillAnchor,
} from "../src/main/pillGeometry";

// The Pill's on-screen placement is pure geometry around a single anchor - the
// top-center point of the pill, the one thing that stays fixed as the window grows
// downward on hover and the one thing persisted across restarts. These tests pin
// that math (the window wiring itself is verified manually per the M1 test plan).

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

describe("boundsForAnchor", () => {
  it("centers the window horizontally on the anchor and hangs it from the anchor's top", () => {
    const bounds = boundsForAnchor({ x: 720, y: 33 }, { width: 160, height: 40 });
    expect(bounds).toEqual({ x: 640, y: 33, width: 160, height: 40 });
  });

  it("keeps the top-center fixed as the window grows for the expanded menu", () => {
    const anchor = { x: 720, y: 33 };
    const collapsed = boundsForAnchor(anchor, { width: 160, height: 40 });
    const expanded = boundsForAnchor(anchor, { width: 240, height: 260 });
    // Same top edge; horizontally centered on the same point.
    expect(expanded.y).toBe(collapsed.y);
    expect(expanded.x + expanded.width / 2).toBe(collapsed.x + collapsed.width / 2);
  });
});

describe("anchorFromBounds", () => {
  it("inverts boundsForAnchor for an even-width window on an integer anchor", () => {
    const anchor = { x: 760, y: 40 };
    const size = { width: 200, height: 48 };
    expect(anchorFromBounds(boundsForAnchor(anchor, size))).toEqual(anchor);
  });
});

describe("defaultAnchor", () => {
  it("sits top-center of the work area, below the menu bar, with the given top margin", () => {
    // workArea.y already excludes the menu bar/notch, so the default only needs a
    // small gap below it and the horizontal center of the work area.
    expect(defaultAnchor(WORK_AREA, 8)).toEqual({ x: 720, y: 33 });
  });
});

describe("clampAnchor", () => {
  const size = { width: 200, height: 48 };

  it("leaves an anchor that already fits untouched", () => {
    const anchor = { x: 720, y: 40 };
    expect(clampAnchor(anchor, size, WORK_AREA)).toEqual(anchor);
  });

  it("pulls a window dragged off the left edge fully back into view", () => {
    const clamped = clampAnchor({ x: -500, y: 40 }, size, WORK_AREA);
    expect(clamped.x).toBe(WORK_AREA.x + size.width / 2);
  });

  it("pulls a window dragged off the right edge fully back into view", () => {
    const clamped = clampAnchor({ x: 99999, y: 40 }, size, WORK_AREA);
    expect(clamped.x).toBe(WORK_AREA.x + WORK_AREA.width - size.width / 2);
  });

  it("never lets the window rise above the work area or sink below its bottom", () => {
    expect(clampAnchor({ x: 720, y: -100 }, size, WORK_AREA).y).toBe(WORK_AREA.y);
    expect(clampAnchor({ x: 720, y: 99999 }, size, WORK_AREA).y).toBe(
      WORK_AREA.y + WORK_AREA.height - size.height,
    );
  });
});

describe("parsePillAnchor", () => {
  it("accepts a well-formed persisted anchor", () => {
    expect(parsePillAnchor({ x: 720, y: 33 })).toEqual({ x: 720, y: 33 });
  });

  it("rejects malformed or non-finite persisted values so a bad file falls back to the default", () => {
    expect(parsePillAnchor(null)).toBeNull();
    expect(parsePillAnchor({ x: 720 })).toBeNull();
    expect(parsePillAnchor({ x: "720", y: 33 })).toBeNull();
    expect(parsePillAnchor({ x: Number.NaN, y: 33 })).toBeNull();
    expect(parsePillAnchor({ x: Number.POSITIVE_INFINITY, y: 33 })).toBeNull();
  });
});
