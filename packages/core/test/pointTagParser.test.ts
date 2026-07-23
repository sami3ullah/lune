import { describe, expect, it } from "vitest";

import { parseAnswerPointTag } from "../src/reasoning/pointTagParser";

/**
 * Unit tests for the answer Point Tag parser: the Core-owned reader that splits a
 * finished answer into the clean human text the Overlay bubble shows and the parsed
 * pointing directive the Overlay acts on. The canonicalizer (tested separately)
 * repairs the tag into this exact grammar first, so the parser only has to read the
 * canonical form:
 *
 *   [POINT:x,y:label]            point on the cursor's screen
 *   [POINT:x,y:label:screenN]    point on another screen
 *   [POINT:none]                 pointing wouldn't help
 */
describe("parseAnswerPointTag", () => {
  it("reads a single-screen point tag and strips it from the display text", () => {
    const parsed = parseAnswerPointTag("Click the Save button up here. [POINT:640,360:Save button]");
    expect(parsed.displayText).toBe("Click the Save button up here.");
    expect(parsed.directive).toEqual({
      kind: "point",
      point: { x: 640, y: 360, label: "Save button", screenNumber: null },
    });
  });

  it("reads the screenN suffix so a multi-monitor point lands on the right display", () => {
    const parsed = parseAnswerPointTag("It's over there. [POINT:100,200:Close:screen2]");
    expect(parsed.displayText).toBe("It's over there.");
    expect(parsed.directive).toEqual({
      kind: "point",
      point: { x: 100, y: 200, label: "Close", screenNumber: 2 },
    });
  });

  it("reads the no-point case", () => {
    const parsed = parseAnswerPointTag("There's nothing to point at. [POINT:none]");
    expect(parsed.displayText).toBe("There's nothing to point at.");
    expect(parsed.directive).toEqual({ kind: "none" });
  });

  it("reports an absent tag and returns the whole answer as display text", () => {
    const parsed = parseAnswerPointTag("Just a plain answer with no tag.");
    expect(parsed.displayText).toBe("Just a plain answer with no tag.");
    expect(parsed.directive).toEqual({ kind: "absent" });
  });

  it("keeps an empty label rather than dropping the point", () => {
    const parsed = parseAnswerPointTag("Here. [POINT:12,34:]");
    expect(parsed.directive).toEqual({
      kind: "point",
      point: { x: 12, y: 34, label: "", screenNumber: null },
    });
  });

  it("only consumes a tag that is the last thing in the answer", () => {
    // A bracket earlier in the prose is left untouched; only a trailing tag is a directive.
    const parsed = parseAnswerPointTag("The array is [1,2,3] and that's all.");
    expect(parsed.directive).toEqual({ kind: "absent" });
    expect(parsed.displayText).toBe("The array is [1,2,3] and that's all.");
  });

  it("tolerates trailing whitespace after the tag", () => {
    const parsed = parseAnswerPointTag("Look here.\n[POINT:5,5:dot]\n  ");
    expect(parsed.displayText).toBe("Look here.");
    expect(parsed.directive).toEqual({
      kind: "point",
      point: { x: 5, y: 5, label: "dot", screenNumber: null },
    });
  });

  it("is case-insensitive on the POINT keyword the canonicalizer normalizes", () => {
    const parsed = parseAnswerPointTag("ok [point:9,9:x]");
    expect(parsed.directive.kind).toBe("point");
  });
});
