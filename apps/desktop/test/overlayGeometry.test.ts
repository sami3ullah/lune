import { describe, expect, it } from "vitest";
import {
  resolveOverlayPointTarget,
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
