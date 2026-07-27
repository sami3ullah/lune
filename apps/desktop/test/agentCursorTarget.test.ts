import { describe, expect, it } from "vitest";
import type { AgentAction } from "@lune/core";
import {
  agentCursorSettleMs,
  describeAgentAction,
  resolveAgentCursorTarget,
} from "../src/main/agent/agentCursorTarget";
import type { AgentDisplayGeometry } from "../src/main/agent/agentCoordinateRemap";

// The pure half of M2-05's "cursor acts the part": turning an Action into the overlay-local
// point the playful cursor should fly to before the Action executes. The overlay send + the
// settle wait are the thin edge (`agentCursorPresenter`); this remap + label is tested.

/** A 2:1 Retina capture on a secondary display offset to the right. */
const GEOMETRY: AgentDisplayGeometry = {
  bounds: { x: 2000, y: 100, width: 2000, height: 1600 },
  capturedWidth: 1000,
  capturedHeight: 800,
};

describe("resolveAgentCursorTarget - actions with a coordinate", () => {
  it("maps a click's captured-pixel point to a display-local overlay point", () => {
    const click: AgentAction = { kind: "click", x: 250, y: 100, consequence: "benign" };
    const target = resolveAgentCursorTarget(click, GEOMETRY);
    // 250/1000 * 2000 = 500 local x; 100/800 * 1600 = 200 local y (origin subtracted).
    expect(target).toEqual({ localX: 500, localY: 200, label: "Click" });
  });

  it("maps a scroll's point too", () => {
    const scroll: AgentAction = {
      kind: "scroll",
      x: 500,
      y: 400,
      direction: "down",
      amount: 3,
      consequence: "benign",
    };
    const target = resolveAgentCursorTarget(scroll, GEOMETRY);
    expect(target).toEqual({ localX: 1000, localY: 800, label: "Scroll" });
  });

  it("maps a compound type that carries a click target", () => {
    const type: AgentAction = { kind: "type", text: "hello", x: 100, y: 200, consequence: "benign" };
    const target = resolveAgentCursorTarget(type, GEOMETRY);
    expect(target?.localX).toBe(200);
    expect(target?.localY).toBe(400);
  });
});

describe("resolveAgentCursorTarget - actions without a coordinate", () => {
  it("returns null for a type-at-focus (no coordinate to fly to)", () => {
    const type: AgentAction = { kind: "type", text: "hi", consequence: "benign" };
    expect(resolveAgentCursorTarget(type, GEOMETRY)).toBeNull();
  });

  it("returns null for key, copy, observe, and done", () => {
    const actions: AgentAction[] = [
      { kind: "key", combo: "cmd+s", consequence: "benign" },
      { kind: "copy", text: "x", consequence: "benign" },
      { kind: "observe", consequence: "benign" },
      { kind: "done", finalText: "done" },
    ];
    for (const action of actions) {
      expect(resolveAgentCursorTarget(action, GEOMETRY)).toBeNull();
    }
  });
});

describe("describeAgentAction", () => {
  it("gives a short human label per kind", () => {
    expect(describeAgentAction({ kind: "click", x: 0, y: 0, consequence: "benign" })).toBe("Click");
    expect(describeAgentAction({ kind: "scroll", x: 0, y: 0, direction: "up", amount: 1, consequence: "benign" })).toBe("Scroll");
    expect(describeAgentAction({ kind: "key", combo: "cmd+s", consequence: "benign" })).toBe("Press cmd+s");
    expect(describeAgentAction({ kind: "observe", consequence: "benign" })).toBe("Look");
  });

  it("includes a short, quoted snippet for a type action", () => {
    expect(describeAgentAction({ kind: "type", text: "hello", consequence: "benign" })).toBe('Type "hello"');
  });

  it("truncates a long typed string so the label stays compact", () => {
    const long = "a".repeat(80);
    const label = describeAgentAction({ kind: "type", text: long, consequence: "benign" });
    expect(label.length).toBeLessThan(40);
    expect(label.endsWith('..."')).toBe(true);
  });
});

describe("agentCursorSettleMs", () => {
  it("is longer for a longer flight, clamped to a sane range", () => {
    const near = agentCursorSettleMs({ x: 0, y: 0 }, { x: 10, y: 0 });
    const far = agentCursorSettleMs({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(far).toBeGreaterThan(near);
    // Even a zero-distance hop waits at least the floor; even a huge one is capped
    // (the flight range mirrors overlayCursorFlight's deliberately unhurried pacing).
    expect(agentCursorSettleMs({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeGreaterThanOrEqual(500);
    expect(far).toBeLessThanOrEqual(1900 + 400);
  });
});
