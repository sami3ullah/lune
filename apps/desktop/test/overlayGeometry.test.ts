import { describe, expect, it } from "vitest";
import {
  resolveOverlayPointTarget,
  toDisplayLocalRect,
  type DisplayCaptureGeometry,
} from "../src/main/overlay/overlayGeometry";

// Pure mapping from a model's Point Tag (coordinates in a screenshot's captured-pixel
// space, tagged with a 1-based screenN) onto a real global-desktop point on the
// correct monitor. This is the Shell half of pointing (the Core repaired + remapped
// the tag into captured-pixel space; the Shell knows the display geometry), so it is
// where "the cursor never gestures at the wrong screen" (user story 25) is enforced.

// Two displays: primary at the origin, a secondary to its right. The secondary was
// captured smaller than its logical size (a downscaled thumbnail), so the mapping has
// to scale captured pixels up into the display's logical bounds, not assume 1:1.
const TWO_DISPLAY_GEOMETRY: DisplayCaptureGeometry[] = [
  {
    screenNumber: 1,
    displayId: 100,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    capturedWidth: 1280,
    capturedHeight: 800,
  },
  {
    screenNumber: 2,
    displayId: 200,
    bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
    capturedWidth: 960,
    capturedHeight: 540,
  },
];

describe("resolveOverlayPointTarget", () => {
  it("maps a captured-pixel point on the cursor's screen to a global point", () => {
    // Centre of screen 1's capture -> centre of screen 1's logical bounds.
    const target = resolveOverlayPointTarget(
      { x: 640, y: 400, screenNumber: 1 },
      TWO_DISPLAY_GEOMETRY,
    );
    expect(target).toEqual({
      displayId: 100,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      screenX: 720,
      screenY: 450,
    });
  });

  it("honors screenN so the point lands on the secondary monitor, offset by its origin", () => {
    // Centre of screen 2's capture -> centre of screen 2, offset by its bounds origin.
    const target = resolveOverlayPointTarget(
      { x: 480, y: 270, screenNumber: 2 },
      TWO_DISPLAY_GEOMETRY,
    );
    expect(target).not.toBeNull();
    expect(target!.displayId).toBe(200);
    expect(target!.screenX).toBe(1440 + 960);
    expect(target!.screenY).toBe(540);
  });

  it("treats a null screenN as the cursor's screen (screen 1)", () => {
    const target = resolveOverlayPointTarget(
      { x: 0, y: 0, screenNumber: null },
      TWO_DISPLAY_GEOMETRY,
    );
    expect(target!.displayId).toBe(100);
    expect(target!.screenX).toBe(0);
    expect(target!.screenY).toBe(0);
  });

  it("falls back to the cursor's screen when screenN is out of range rather than guessing wrong", () => {
    // A model naming a screen that isn't connected must not gesture at a wrong
    // monitor; the safe default is the primary-focus screen (screen 1).
    const target = resolveOverlayPointTarget(
      { x: 640, y: 400, screenNumber: 7 },
      TWO_DISPLAY_GEOMETRY,
    );
    expect(target!.displayId).toBe(100);
  });

  it("clamps a coordinate outside the captured frame to the display's edge", () => {
    const target = resolveOverlayPointTarget(
      { x: 100000, y: -50, screenNumber: 1 },
      TWO_DISPLAY_GEOMETRY,
    );
    expect(target!.screenX).toBe(1440);
    expect(target!.screenY).toBe(0);
  });

  it("returns null when there is no capture geometry to map against", () => {
    expect(resolveOverlayPointTarget({ x: 10, y: 10, screenNumber: 1 }, [])).toBeNull();
  });

  it("does not divide by zero on a degenerate capture size", () => {
    const target = resolveOverlayPointTarget({ x: 10, y: 10, screenNumber: 1 }, [
      {
        screenNumber: 1,
        displayId: 100,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        capturedWidth: 0,
        capturedHeight: 0,
      },
    ]);
    // A zero-size capture can't be mapped meaningfully; land on the display origin.
    expect(target).toEqual({
      displayId: 100,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      screenX: 0,
      screenY: 0,
    });
  });
});

describe("toDisplayLocalRect", () => {
  // A secondary display offset to the right of the primary, so a wizard on the primary
  // must not leak onto the secondary's local rect (that would drag the intro card off).
  const PRIMARY = { x: 0, y: 0, width: 1440, height: 900 };
  const SECONDARY = { x: 1440, y: 0, width: 1920, height: 1080 };
  // A 560x640 onboarding window centred on the primary display.
  const WIZARD = { x: 440, y: 130, width: 560, height: 640 };

  it("converts a wizard on this display into window-local coordinates", () => {
    expect(toDisplayLocalRect(WIZARD, PRIMARY)).toEqual({ x: 440, y: 130, width: 560, height: 640 });
  });

  it("subtracts a display's origin so a wizard's local rect is relative to that window", () => {
    // The same global rect on a display whose origin is offset lands at a shifted local x/y.
    const onSecondary = { x: 1600, y: 200, width: 400, height: 300 };
    expect(toDisplayLocalRect(onSecondary, SECONDARY)).toEqual({ x: 160, y: 200, width: 400, height: 300 });
  });

  it("returns null when the rect isn't on this display (so that window avoids nothing)", () => {
    expect(toDisplayLocalRect(WIZARD, SECONDARY)).toBeNull();
  });

  it("clips a rect that straddles two displays to the part on this one", () => {
    // Straddles the primary/secondary seam at x=1440; only the left half is on the primary.
    const straddling = { x: 1340, y: 100, width: 200, height: 200 };
    expect(toDisplayLocalRect(straddling, PRIMARY)).toEqual({ x: 1340, y: 100, width: 100, height: 200 });
  });
});
