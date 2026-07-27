import type { ParsedShape, PointDirective } from "@lune/core";

// A dev-only diagnostic (env-gated on LUNE_REASONING_DEBUG, off on a normal launch, in the
// LUNE_*_DEV spirit of the other dev triggers): print, per completed reasoning turn, the
// raw text the model emitted and exactly what the tag parsers made of it. It answers the
// question that stumped a teaching turn - "did the model even try to draw, or did the
// drawing pipeline drop it?" - and shows each shape's coordinates against the pixel space
// they live in, so a reader can see at a glance whether a weak model's coordinates land
// on-screen. The formatter is pure so it can be tested and so the call site stays a
// one-liner; only {@link isReasoningDebugEnabled} touches the environment.

/** The env var that turns on raw reasoning-output logging (any non-empty value = on). */
const REASONING_DEBUG_ENV = "LUNE_REASONING_DEBUG";

/** Whether raw reasoning-output logging is enabled this launch. */
export function isReasoningDebugEnabled(): boolean {
  const value = process.env[REASONING_DEBUG_ENV];
  return value !== undefined && value.trim().length > 0;
}

/** One parsed shape as a compact, human-readable line for the debug block. */
function formatShape(shape: ParsedShape): string {
  const where = shape.screenNumber === null ? "screen1 (cursor)" : `screen${shape.screenNumber}`;
  const coordinates =
    shape.radius !== null
      ? `center (${shape.points[0]?.x ?? "?"}, ${shape.points[0]?.y ?? "?"}) r=${shape.radius}`
      : shape.points.map((point) => `(${point.x}, ${point.y})`).join(" -> ");
  const label = shape.label.length > 0 ? ` "${shape.label}"` : "";
  return `  - ${shape.kind}${label}: ${coordinates} [${where}]`;
}

/** The point directive as one line: whether the model pointed, and where. */
function formatPointTag(directive: PointDirective): string {
  switch (directive.kind) {
    case "point":
      return `point tag: yes -> (${directive.point.x}, ${directive.point.y}) "${directive.point.label}"`;
    case "none":
      return "point tag: none (model explicitly declined to point)";
    case "absent":
      return "point tag: absent (no tag emitted)";
  }
}

/**
 * Formats a completed reasoning turn and its parsed tags into a multi-line debug block.
 * Pure (no I/O): the caller decides whether to print it (see {@link isReasoningDebugEnabled}).
 * `coordinateSpace` is the captured-pixel dimensions the shape/point coordinates live in, so
 * a reader can judge whether they fall on-screen - the usual failure mode for a weak model
 * that emits shapes but grounds them badly.
 */
export function formatReasoningCompletion(input: {
  rawAnswer: string;
  shapes: readonly ParsedShape[];
  pointDirective: PointDirective;
  actGoal: string | null;
  coordinateSpace?: { width: number; height: number };
}): string {
  const { rawAnswer, shapes, pointDirective, actGoal, coordinateSpace } = input;
  const lines: string[] = ["[lune:reasoning-debug] turn completed"];
  if (coordinateSpace) {
    lines.push(`coordinate space (captured px): ${coordinateSpace.width}x${coordinateSpace.height}`);
  }
  lines.push("--- raw model output ---");
  lines.push(rawAnswer.length > 0 ? rawAnswer : "(empty)");
  lines.push("------------------------");
  lines.push(`shapes emitted: ${shapes.length}`);
  for (const shape of shapes) {
    lines.push(formatShape(shape));
  }
  lines.push(formatPointTag(pointDirective));
  lines.push(`act tag: ${actGoal === null ? "no" : `yes -> ${actGoal}`}`);
  return lines.join("\n");
}
