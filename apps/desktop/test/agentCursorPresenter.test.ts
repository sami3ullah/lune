import { describe, expect, it } from "vitest";
import type { AgentAction } from "@lune/core";
import {
  createAgentCursorPresenter,
  type AgentCursorOverlay,
} from "../src/main/agent/agentCursorPresenter";
import type { AgentCursorTarget } from "../src/main/agent/agentCursorTarget";
import { AGENT_CURSOR_SETTLE_MAX_MS } from "../src/main/agent/agentCursorTarget";
import type { AgentDisplayGeometry } from "../src/main/agent/agentCoordinateRemap";

// The presenter's sequencing (M2-05): resolve the target, fly the Overlay cursor there, wait
// for it to land - with the Overlay and the clock faked so the flight is asserted without a
// real window or wall-clock time.

const GEOMETRY: AgentDisplayGeometry = {
  bounds: { x: 0, y: 0, width: 1000, height: 800 },
  capturedWidth: 1000,
  capturedHeight: 800,
};

const DISPLAY_ID = 42;

interface Harness {
  points: Array<{ displayId: number; target: AgentCursorTarget }>;
  ends: number[];
  sleeps: number[];
  show: ReturnType<typeof createAgentCursorPresenter>["showActionTarget"];
  finish: ReturnType<typeof createAgentCursorPresenter>["finish"];
}

function makeHarness(): Harness {
  const points: Array<{ displayId: number; target: AgentCursorTarget }> = [];
  const ends: number[] = [];
  const sleeps: number[] = [];
  const overlay: AgentCursorOverlay = {
    pointCursorAt: (displayId, target) => points.push({ displayId, target }),
    endPointing: (displayId) => ends.push(displayId),
  };
  const presenter = createAgentCursorPresenter({
    overlay,
    displayId: DISPLAY_ID,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { points, ends, sleeps, show: presenter.showActionTarget, finish: presenter.finish };
}

describe("createAgentCursorPresenter", () => {
  it("flies the cursor to a click's target on the bound display, then waits", async () => {
    const harness = makeHarness();
    const click: AgentAction = { kind: "click", x: 500, y: 400, consequence: "benign" };

    await harness.show(click, GEOMETRY);

    expect(harness.points).toHaveLength(1);
    expect(harness.points[0]?.displayId).toBe(DISPLAY_ID);
    expect(harness.points[0]?.target).toEqual({ localX: 500, localY: 400, label: "Click" });
    // First hop of the run waits the worst case (the mouse start is unknown here).
    expect(harness.sleeps).toEqual([AGENT_CURSOR_SETTLE_MAX_MS]);
  });

  it("does nothing for an Action with no on-screen target (type-at-focus)", async () => {
    const harness = makeHarness();
    const typeAtFocus: AgentAction = { kind: "type", text: "hi", consequence: "benign" };

    await harness.show(typeAtFocus, GEOMETRY);

    expect(harness.points).toHaveLength(0);
    expect(harness.sleeps).toHaveLength(0);
  });

  it("waits a distance-based (shorter) time for a within-run hop after the first", async () => {
    const harness = makeHarness();
    await harness.show({ kind: "click", x: 500, y: 400, consequence: "benign" }, GEOMETRY);
    await harness.show({ kind: "click", x: 510, y: 400, consequence: "benign" }, GEOMETRY);

    expect(harness.points).toHaveLength(2);
    // Second hop is a short 10px move, so it waits less than the worst-case first hop.
    expect(harness.sleeps[1]).toBeLessThan(harness.sleeps[0]!);
  });

  it("releases the cursor to the mouse on finish, once the run pointed at least once", async () => {
    const harness = makeHarness();
    await harness.show({ kind: "click", x: 500, y: 400, consequence: "benign" }, GEOMETRY);
    harness.finish();

    expect(harness.ends).toEqual([DISPLAY_ID]);
  });

  it("finish is a no-op when nothing was ever pointed (an advisory run)", async () => {
    const harness = makeHarness();
    await harness.show({ kind: "type", text: "hi", consequence: "benign" }, GEOMETRY);
    harness.finish();

    expect(harness.ends).toHaveLength(0);
  });
});
