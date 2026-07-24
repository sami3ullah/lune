import { describe, expect, it } from "vitest";
import type { AgentAction } from "@lune/core";
import { applyConsequenceFloor } from "@lune/core";
import { buildAgentTargetSignal, type RawAxSignal } from "../src/main/agent/agentTargetSignal";
import type { AgentDisplayGeometry } from "../src/main/agent/agentCoordinateRemap";

// The pure half of M2-05's AX target signal: turning the raw accessibility read (in the
// display's global-logical coordinate space, top-left origin) into the Core's
// `AgentTargetSignal` whose element frames sit in the *captured-pixel* space the model's
// Action coordinates use - so the Consequence floor's click-hit-test lines up. The raw OS
// read (`axSignalProvider`) is the untested edge; this remap + filter + degrade is tested.

/** A Retina-ish geometry: a 2000x1600 logical display captured down to a 1000x800 frame. */
const GEOMETRY: AgentDisplayGeometry = {
  bounds: { x: 0, y: 0, width: 2000, height: 1600 },
  capturedWidth: 1000,
  capturedHeight: 800,
};

/** A geometry on a secondary display offset to the right of the primary. */
const OFFSET_GEOMETRY: AgentDisplayGeometry = {
  bounds: { x: 2000, y: 0, width: 1000, height: 800 },
  capturedWidth: 1000,
  capturedHeight: 800,
};

describe("buildAgentTargetSignal - degradation", () => {
  it("returns undefined for a null raw signal (poor / absent accessibility tree)", () => {
    expect(buildAgentTargetSignal(null, GEOMETRY)).toBeUndefined();
  });

  it("returns undefined when the raw signal carries nothing useful", () => {
    expect(buildAgentTargetSignal({}, GEOMETRY)).toBeUndefined();
    expect(buildAgentTargetSignal({ elements: [] }, GEOMETRY)).toBeUndefined();
  });

  it("passes through the focused element even when no elements were captured", () => {
    const raw: RawAxSignal = { focusedLabel: "Search", focusedRole: "AXTextField" };
    expect(buildAgentTargetSignal(raw, GEOMETRY)).toEqual({
      focusedLabel: "Search",
      focusedRole: "AXTextField",
    });
  });
});

describe("buildAgentTargetSignal - element remap to captured-pixel space", () => {
  it("scales a global-logical frame down into the captured frame (2:1 here)", () => {
    const raw: RawAxSignal = {
      elements: [{ x: 400, y: 200, width: 200, height: 80, label: "Send", role: "AXButton" }],
    };
    const signal = buildAgentTargetSignal(raw, GEOMETRY);
    // 2000->1000 is a 0.5 scale: x 400->200, y 200->100, w 200->100, h 80->40.
    expect(signal?.elements).toEqual([
      { x: 200, y: 100, width: 100, height: 40, label: "Send", role: "AXButton" },
    ]);
  });

  it("subtracts the display origin so a secondary-display frame maps into its own capture", () => {
    const raw: RawAxSignal = {
      elements: [{ x: 2100, y: 100, width: 100, height: 50, role: "AXLink" }],
    };
    const signal = buildAgentTargetSignal(raw, OFFSET_GEOMETRY);
    // origin 2000 subtracted, then 1:1 scale: x 2100->100, y 100->100.
    expect(signal?.elements).toEqual([{ x: 100, y: 100, width: 100, height: 50, role: "AXLink" }]);
  });

  it("drops elements that fall entirely outside the captured frame", () => {
    const raw: RawAxSignal = {
      elements: [
        { x: -500, y: 100, width: 100, height: 50, label: "offscreen-left" },
        { x: 400, y: 200, width: 200, height: 80, label: "onscreen" },
        { x: 5000, y: 100, width: 100, height: 50, label: "offscreen-right" },
      ],
    };
    const signal = buildAgentTargetSignal(raw, GEOMETRY);
    expect(signal?.elements?.map((element) => element.label)).toEqual(["onscreen"]);
  });

  it("drops degenerate (zero-area) frames so hit-testing never matches them", () => {
    const raw: RawAxSignal = {
      elements: [
        { x: 100, y: 100, width: 0, height: 40, label: "zero-width" },
        { x: 100, y: 100, width: 40, height: 40, label: "real" },
      ],
    };
    const signal = buildAgentTargetSignal(raw, GEOMETRY);
    expect(signal?.elements?.map((element) => element.label)).toEqual(["real"]);
  });

  it("keeps a partially-visible frame clipped so its on-screen part still hit-tests", () => {
    const raw: RawAxSignal = {
      // Straddles the left edge in logical space (x -100..300 -> captured -50..150).
      elements: [{ x: -100, y: 200, width: 400, height: 80, label: "straddles" }],
    };
    const signal = buildAgentTargetSignal(raw, GEOMETRY);
    const element = signal?.elements?.[0];
    expect(element?.label).toBe("straddles");
    // Clipped to the frame: left edge at 0, right edge at 150 (width 150).
    expect(element?.x).toBe(0);
    expect(element?.width).toBe(150);
  });
});

describe("end to end with the Core Consequence floor (AC#1)", () => {
  // v1's gap: the Shell sent no element frames, so the floor's click-hit-test was inert.
  // These drive the whole path the ticket closes - raw AX read (global coords) ->
  // buildAgentTargetSignal (captured-pixel) -> the Core floor hit-testing an Action's
  // coordinate against it - to prove a click on a Send/hyperlink element now escalates.

  /** A raw read with a Send button, a hyperlink, and a benign label, in global coords. */
  const RAW: RawAxSignal = {
    elements: [
      { x: 400, y: 200, width: 200, height: 80, label: "Send", role: "AXButton" },
      { x: 400, y: 400, width: 200, height: 80, label: "innoscripta.com", role: "AXLink" },
      { x: 400, y: 600, width: 200, height: 80, label: "Cancel", role: "AXButton" },
    ],
  };

  /** A click (captured-pixel space) landing inside the frame that maps from `globalY`. */
  function clickAtGlobalRow(globalY: number): AgentAction {
    // 0.5 capture scale, origin 0: global (500, globalY+40) -> captured (250, (globalY+40)/2).
    return { kind: "click", x: 250, y: (globalY + 40) / 2, consequence: "benign" };
  }

  it("escalates a model-benign click on a 'Send' button to consequential", () => {
    const signal = buildAgentTargetSignal(RAW, GEOMETRY);
    const resolved = applyConsequenceFloor(clickAtGlobalRow(200), signal);
    expect(resolved.kind === "click" && resolved.consequence).toBe("consequential");
  });

  it("escalates a click on a hyperlink element (navigates away)", () => {
    const signal = buildAgentTargetSignal(RAW, GEOMETRY);
    const resolved = applyConsequenceFloor(clickAtGlobalRow(400), signal);
    expect(resolved.kind === "click" && resolved.consequence).toBe("consequential");
  });

  it("leaves a benign click ('Cancel' button) benign", () => {
    const signal = buildAgentTargetSignal(RAW, GEOMETRY);
    const resolved = applyConsequenceFloor(clickAtGlobalRow(600), signal);
    expect(resolved.kind === "click" && resolved.consequence).toBe("benign");
  });
});

describe("buildAgentTargetSignal - resilience", () => {
  it("keeps a zero-size capture from producing NaN (lands elements at the origin)", () => {
    const zeroCapture: AgentDisplayGeometry = {
      bounds: { x: 0, y: 0, width: 2000, height: 1600 },
      capturedWidth: 0,
      capturedHeight: 0,
    };
    const raw: RawAxSignal = { elements: [{ x: 400, y: 200, width: 200, height: 80, label: "Send" }] };
    const signal = buildAgentTargetSignal(raw, zeroCapture);
    // No usable capture frame: the element collapses away rather than yielding NaN.
    expect(signal).toBeUndefined();
  });
});
