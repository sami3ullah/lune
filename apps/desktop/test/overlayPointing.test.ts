import { describe, expect, it } from "vitest";
import { planCompletionMessages } from "../src/main/overlay/overlayPointing";
import type { DisplayCaptureGeometry } from "../src/main/overlay/overlayGeometry";
import type { PointDirective } from "@lune/core";

// The completion planner decides what the Overlay does when an answer finishes: fly
// the cursor to the referenced element on the correct monitor, and always close out
// the interaction on the display the answer streamed on.

const TWO_DISPLAY_GEOMETRY: DisplayCaptureGeometry[] = [
  {
    screenNumber: 1,
    displayId: 100,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    capturedWidth: 1440,
    capturedHeight: 900,
  },
  {
    screenNumber: 2,
    displayId: 200,
    bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
    capturedWidth: 1920,
    capturedHeight: 1080,
  },
];

describe("planCompletionMessages", () => {
  it("just ends the cursor display's interaction when the answer doesn't point", () => {
    const absent: PointDirective = { kind: "absent" };
    const none: PointDirective = { kind: "none" };
    expect(planCompletionMessages(absent, TWO_DISPLAY_GEOMETRY, 100)).toEqual([
      { displayId: 100, event: { type: "activity-end" } },
    ]);
    expect(planCompletionMessages(none, TWO_DISPLAY_GEOMETRY, 100)).toEqual([
      { displayId: 100, event: { type: "activity-end" } },
    ]);
  });

  it("points on the cursor's own display, then ends - a single window", () => {
    const directive: PointDirective = {
      kind: "point",
      point: { x: 720, y: 450, label: "Save", screenNumber: 1 },
    };
    const messages = planCompletionMessages(directive, TWO_DISPLAY_GEOMETRY, 100);
    expect(messages).toEqual([
      { displayId: 100, event: { type: "point", point: { localX: 720, localY: 450, label: "Save" } } },
      { displayId: 100, event: { type: "activity-end" } },
    ]);
  });

  it("runs a pointing episode on the other monitor, and ends the cursor display separately", () => {
    const directive: PointDirective = {
      kind: "point",
      point: { x: 960, y: 540, label: "Close", screenNumber: 2 },
    };
    const messages = planCompletionMessages(directive, TWO_DISPLAY_GEOMETRY, 100);
    // Target is display 200; its local point is the global point minus its bounds origin.
    expect(messages).toEqual([
      { displayId: 200, event: { type: "activity-start" } },
      { displayId: 200, event: { type: "point", point: { localX: 960, localY: 540, label: "Close" } } },
      { displayId: 200, event: { type: "activity-end" } },
      { displayId: 100, event: { type: "activity-end" } },
    ]);
  });

  it("ends without pointing when the target can't be resolved (no geometry)", () => {
    const directive: PointDirective = {
      kind: "point",
      point: { x: 10, y: 10, label: "x", screenNumber: 1 },
    };
    expect(planCompletionMessages(directive, [], 100)).toEqual([
      { displayId: 100, event: { type: "activity-end" } },
    ]);
  });
});
