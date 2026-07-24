import { describe, expect, it } from "vitest";
import type { AgentAction } from "@lune/core";
import {
  remapActionToGlobalSpace,
  remapScreenshotPointToGlobal,
  type AgentDisplayGeometry,
} from "../src/main/agent/agentCoordinateRemap";

// Pure remap from a canonical Action's coordinate space (the screenshot-pixel space the
// Screen Agent Vendor reasoned in) onto the real global-desktop logical point synthetic
// input needs. This is the Shell's half of "coordinates land correctly on secondary
// displays and scaled resolutions" (M2-02 acceptance #2); keeping it a pure function of
// the capture geometry is what lets that be unit-tested without Electron or real input.
// It mirrors the Overlay's Point Tag remap, narrowed to the single display a Session is
// bound to.

/** Primary display at the origin, captured at exactly its logical size (1:1). */
const PRIMARY_ONE_TO_ONE: AgentDisplayGeometry = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  capturedWidth: 1440,
  capturedHeight: 900,
};

/**
 * A secondary display to the right of the primary, captured smaller than its logical
 * size (a Retina panel captured at half its point size, so the remap must scale
 * captured pixels up into the logical bounds AND offset onto the second monitor).
 */
const SECONDARY_SCALED: AgentDisplayGeometry = {
  bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
  capturedWidth: 960,
  capturedHeight: 540,
};

describe("remapScreenshotPointToGlobal", () => {
  it("maps a point 1:1 on the primary display straight through", () => {
    expect(remapScreenshotPointToGlobal({ x: 720, y: 450 }, PRIMARY_ONE_TO_ONE)).toEqual({
      x: 720,
      y: 450,
    });
  });

  it("scales captured pixels up to logical bounds and offsets onto a secondary display", () => {
    // Centre of the capture (480,270 of 960x540) -> centre of the secondary's logical
    // bounds: x = 1440 + 0.5*1920 = 2400, y = 0 + 0.5*1080 = 540.
    expect(remapScreenshotPointToGlobal({ x: 480, y: 270 }, SECONDARY_SCALED)).toEqual({
      x: 2400,
      y: 540,
    });
  });

  it("handles a non-1:1 scale factor that is not a clean half", () => {
    const geometry: AgentDisplayGeometry = {
      bounds: { x: 0, y: 0, width: 1000, height: 1000 },
      capturedWidth: 1280,
      capturedHeight: 800,
    };
    // x 640/1280 * 1000 = 500; y 400/800 * 1000 = 500.
    expect(remapScreenshotPointToGlobal({ x: 640, y: 400 }, geometry)).toEqual({ x: 500, y: 500 });
  });

  it("clamps a point past the captured frame to the display's far edge, never off it", () => {
    expect(remapScreenshotPointToGlobal({ x: 5000, y: 5000 }, SECONDARY_SCALED)).toEqual({
      x: 1440 + 1920,
      y: 1080,
    });
  });

  it("clamps a negative point to the display's origin", () => {
    expect(remapScreenshotPointToGlobal({ x: -50, y: -50 }, SECONDARY_SCALED)).toEqual({
      x: 1440,
      y: 0,
    });
  });

  it("lands on the display origin rather than producing NaN for a zero-size capture", () => {
    const geometry: AgentDisplayGeometry = {
      bounds: { x: 100, y: 200, width: 800, height: 600 },
      capturedWidth: 0,
      capturedHeight: 0,
    };
    expect(remapScreenshotPointToGlobal({ x: 10, y: 10 }, geometry)).toEqual({ x: 100, y: 200 });
  });
});

describe("remapActionToGlobalSpace", () => {
  it("remaps a click's coordinate", () => {
    const action: AgentAction = { kind: "click", x: 480, y: 270, consequence: "benign" };
    expect(remapActionToGlobalSpace(action, SECONDARY_SCALED)).toEqual({
      kind: "click",
      x: 2400,
      y: 540,
      consequence: "benign",
    });
  });

  it("remaps a scroll's coordinate while preserving direction, amount, and consequence", () => {
    const action: AgentAction = {
      kind: "scroll",
      x: 480,
      y: 270,
      direction: "down",
      amount: 3,
      consequence: "consequential",
    };
    expect(remapActionToGlobalSpace(action, SECONDARY_SCALED)).toEqual({
      kind: "scroll",
      x: 2400,
      y: 540,
      direction: "down",
      amount: 3,
      consequence: "consequential",
    });
  });

  it("remaps a compound type's click target when present", () => {
    const action: AgentAction = {
      kind: "type",
      text: "hello",
      x: 480,
      y: 270,
      pressEnter: true,
      consequence: "benign",
    };
    expect(remapActionToGlobalSpace(action, SECONDARY_SCALED)).toEqual({
      kind: "type",
      text: "hello",
      x: 2400,
      y: 540,
      pressEnter: true,
      consequence: "benign",
    });
  });

  it("leaves a focus-typing type (no target) unchanged", () => {
    const action: AgentAction = { kind: "type", text: "hello", consequence: "benign" };
    expect(remapActionToGlobalSpace(action, SECONDARY_SCALED)).toEqual(action);
  });

  it("passes key, copy, observe, and done through unchanged (no coordinates)", () => {
    const actions: AgentAction[] = [
      { kind: "key", combo: "cmd+s", consequence: "benign" },
      { kind: "copy", text: "clip", consequence: "benign" },
      { kind: "observe", consequence: "benign" },
      { kind: "done", finalText: "all set" },
    ];
    for (const action of actions) {
      expect(remapActionToGlobalSpace(action, SECONDARY_SCALED)).toEqual(action);
    }
  });
});
