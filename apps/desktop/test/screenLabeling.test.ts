import { describe, expect, it } from "vitest";
import { planScreenCaptures } from "../src/main/screenCapture/screenLabeling";

// The order + 1-based screen number this produces is the contract the model's Point
// Tag `screenN` and the Overlay's screen mapping both rely on, so these cases pin it.

describe("planScreenCaptures", () => {
  it("labels a single display as the user's screen with the cursor here", () => {
    const plans = planScreenCaptures([{ id: 1 }], 1);
    expect(plans).toEqual([
      { displayId: 1, screenNumber: 1, label: "user's screen (cursor is here)", isCursorScreen: true },
    ]);
  });

  it("still labels the sole display as the user's screen even if the cursor read as off-screen", () => {
    const plans = planScreenCaptures([{ id: 7 }], null);
    expect(plans[0]!.label).toBe("user's screen (cursor is here)");
    expect(plans[0]!.isCursorScreen).toBe(false);
  });

  it("presents the cursor's display first as screen 1 (primary focus) and numbers the rest behind it", () => {
    // OS order lists the secondary display (id 1) before the cursor's display (id 2).
    const plans = planScreenCaptures([{ id: 1 }, { id: 2 }], 2);

    expect(plans.map((plan) => plan.displayId)).toEqual([2, 1]);
    expect(plans[0]).toEqual({
      displayId: 2,
      screenNumber: 1,
      label: "screen 1 of 2 - cursor is on this screen (primary focus)",
      isCursorScreen: true,
    });
    expect(plans[1]).toEqual({
      displayId: 1,
      screenNumber: 2,
      label: "screen 2 of 2 - secondary screen",
      isCursorScreen: false,
    });
  });

  it("keeps the OS order and flags no primary focus when the cursor is on no connected display", () => {
    const plans = planScreenCaptures([{ id: 10 }, { id: 20 }, { id: 30 }], null);

    expect(plans.map((plan) => plan.displayId)).toEqual([10, 20, 30]);
    expect(plans.every((plan) => plan.isCursorScreen === false)).toBe(true);
    expect(plans.map((plan) => plan.label)).toEqual([
      "screen 1 of 3 - secondary screen",
      "screen 2 of 3 - secondary screen",
      "screen 3 of 3 - secondary screen",
    ]);
  });

  it("preserves the order of the non-cursor displays behind the cursor's", () => {
    const plans = planScreenCaptures([{ id: 1 }, { id: 2 }, { id: 3 }], 3);
    expect(plans.map((plan) => plan.displayId)).toEqual([3, 1, 2]);
  });

  it("captures nothing when there are no displays", () => {
    expect(planScreenCaptures([], null)).toEqual([]);
  });
});
