import { afterEach, describe, expect, it } from "vitest";
import type { ParsedShape, ShapeStyle } from "@lune/core";

import {
  formatReasoningCompletion,
  isReasoningDebugEnabled,
} from "../src/main/reasoningDebugLog";

// The dev-only reasoning debug log (LUNE_REASONING_DEBUG). The formatter is pure, so its
// output is pinned directly; the env gate is exercised by toggling the var.

const STYLE: ShapeStyle = { stroke: "solid", filled: false, color: null };

function circle(overrides: Partial<ParsedShape> = {}): ParsedShape {
  return {
    kind: "circle",
    points: [{ x: 640, y: 300 }],
    radius: 40,
    label: "subscribed button",
    style: STYLE,
    screenNumber: null,
    ...overrides,
  };
}

describe("isReasoningDebugEnabled", () => {
  const original = process.env.LUNE_REASONING_DEBUG;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.LUNE_REASONING_DEBUG;
    } else {
      process.env.LUNE_REASONING_DEBUG = original;
    }
  });

  it("is off when the var is unset or blank", () => {
    delete process.env.LUNE_REASONING_DEBUG;
    expect(isReasoningDebugEnabled()).toBe(false);
    process.env.LUNE_REASONING_DEBUG = "  ";
    expect(isReasoningDebugEnabled()).toBe(false);
  });

  it("is on for any non-blank value", () => {
    process.env.LUNE_REASONING_DEBUG = "1";
    expect(isReasoningDebugEnabled()).toBe(true);
  });
});

describe("formatReasoningCompletion", () => {
  it("reports zero shapes for a spoken-only answer (the teaching-turn failure)", () => {
    const output = formatReasoningCompletion({
      rawAnswer: "click the subscribed button, then choose unsubscribe.",
      shapes: [],
      pointDirective: { kind: "absent" },
      actGoal: null,
      coordinateSpace: { width: 640, height: 360 },
    });

    expect(output).toContain("coordinate space (captured px): 640x360");
    expect(output).toContain("click the subscribed button");
    expect(output).toContain("shapes emitted: 0");
    expect(output).toContain("point tag: absent");
    expect(output).toContain("act tag: no");
  });

  it("lists each shape with its coordinates and space, plus point and act tags", () => {
    const output = formatReasoningCompletion({
      rawAnswer: "here's how.",
      shapes: [
        circle(),
        {
          kind: "arrow",
          points: [
            { x: 100, y: 200 },
            { x: 300, y: 400 },
          ],
          radius: null,
          label: "menu",
          style: STYLE,
          screenNumber: 2,
        },
      ],
      pointDirective: { kind: "point", point: { x: 640, y: 300, label: "here", screenNumber: null } },
      actGoal: null,
      coordinateSpace: { width: 640, height: 360 },
    });

    expect(output).toContain("shapes emitted: 2");
    expect(output).toContain('circle "subscribed button": center (640, 300) r=40 [screen1 (cursor)]');
    expect(output).toContain('arrow "menu": (100, 200) -> (300, 400) [screen2]');
    expect(output).toContain('point tag: yes -> (640, 300) "here"');
  });

  it("omits the coordinate-space line when no dimensions are given", () => {
    const output = formatReasoningCompletion({
      rawAnswer: "",
      shapes: [],
      pointDirective: { kind: "none" },
      actGoal: "unsubscribe from the channel",
    });

    expect(output).not.toContain("coordinate space");
    expect(output).toContain("(empty)");
    expect(output).toContain("point tag: none");
    expect(output).toContain("act tag: yes -> unsubscribe from the channel");
  });
});
