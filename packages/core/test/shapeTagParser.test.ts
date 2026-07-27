import { describe, expect, it } from "vitest";

import { parseAnswerShapeTags } from "../src/reasoning/shapeTagParser";

/**
 * Unit tests for the Shape Tag reader (M3-02): splits a finished answer into the clean
 * human text and the list of shapes to draw, reading back the canonical form the
 * canonicalizer produces. The teaching-overlay counterpart of the Point Tag parser.
 */

describe("parseAnswerShapeTags", () => {
  it("returns no shapes and the text unchanged when there is no shape tag", () => {
    const result = parseAnswerShapeTags("here's how that works.");
    expect(result.shapes).toEqual([]);
    expect(result.displayText).toBe("here's how that works.");
  });

  it("reads a circle: center, radius, label, and default style", () => {
    const result = parseAnswerShapeTags("look here [CIRCLE:640,360,50:save button]");
    expect(result.displayText).toBe("look here");
    expect(result.shapes).toEqual([
      {
        kind: "circle",
        points: [{ x: 640, y: 360 }],
        radius: 50,
        label: "save button",
        style: { stroke: "solid", filled: false, color: null },
        screenNumber: null,
      },
    ]);
  });

  it("reads a two-point shape's start and end (no radius)", () => {
    const result = parseAnswerShapeTags("watch [ARROW:100,100,300,320:it flows here:screen2]");
    expect(result.shapes).toEqual([
      {
        kind: "arrow",
        points: [
          { x: 100, y: 100 },
          { x: 300, y: 320 },
        ],
        radius: null,
        label: "it flows here",
        style: { stroke: "solid", filled: false, color: null },
        screenNumber: 2,
      },
    ]);
  });

  it("reads the style modifiers (stroke, fill, color)", () => {
    const result = parseAnswerShapeTags("[RECT:0,0,10,10:the box:dashed:filled:#ff0000]");
    expect(result.shapes[0]!.style).toEqual({ stroke: "dashed", filled: true, color: "#ff0000" });
  });

  it("reads a run of shapes in the order the model emitted them", () => {
    // "circle the save button and draw an arrow from A to B" - two shapes, one turn.
    const result = parseAnswerShapeTags(
      "circle this and draw an arrow [CIRCLE:100,100,20:the source] [ARROW:100,100,200,200:it flows]",
    );
    expect(result.displayText).toBe("circle this and draw an arrow");
    expect(result.shapes.map((shape) => shape.kind)).toEqual(["circle", "arrow"]);
    expect(result.shapes[0]!.points).toEqual([{ x: 100, y: 100 }]);
    expect(result.shapes[1]!.points).toEqual([
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ]);
  });

  it("leaves an ordinary trailing bracket alone", () => {
    const result = parseAnswerShapeTags("the array index is arr[0]");
    expect(result.shapes).toEqual([]);
    expect(result.displayText).toBe("the array index is arr[0]");
  });

  it("does not treat a word like 'lines' as a line shape", () => {
    const result = parseAnswerShapeTags("check the [lines] section");
    expect(result.shapes).toEqual([]);
  });
});
