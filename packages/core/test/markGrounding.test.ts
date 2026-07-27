import { describe, expect, it } from "vitest";

import {
  buildMarkRefinementRequest,
  parseMarkRefinementReply,
} from "../src/reasoning/markGrounding";

/**
 * Unit tests for mark grounding refinement (the drawing-accuracy fix): the request one
 * refinement call sends and the tolerant parse of its reply into an element box in
 * crop-pixel space. Every parse failure mode must return null so the caller keeps the
 * mark's original coordinates ("no worse than before").
 */

describe("buildMarkRefinementRequest", () => {
  it("builds a single-turn request carrying the crop, its dimensions, and the label", () => {
    const request = buildMarkRefinementRequest({
      base64Data: "abc123",
      mediaType: "image/jpeg",
      widthInPixels: 640,
      heightInPixels: 400,
      label: "book a demo button",
    });

    expect(request.system).toContain("[RECT:x1,y1,x2,y2]");
    expect(request.system).toContain("[NONE]");
    expect(request.maxTokens).toBeGreaterThan(0);
    // A refinement call is a machine-read micro-task: hidden reasoning only delays the
    // drawing, so the request asks every Vendor for its minimum.
    expect(request.reasoningEffort).toBe("minimal");
    expect(request.messages).toHaveLength(1);
    const content = request.messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Exclude<typeof content, string>;
    expect(blocks[0]).toEqual({ type: "image", base64Data: "abc123", mediaType: "image/jpeg" });
    expect(blocks[1]).toMatchObject({ type: "text" });
    const text = (blocks[1] as { text: string }).text;
    // The exact `<width>x<height> pixels` form the pipeline's downscale rewrite matches.
    expect(text).toContain("640x400 pixels");
    expect(text).toContain('"book a demo button"');
  });

  it("carries the anchor hint when the caller passes the guess's position", () => {
    const request = buildMarkRefinementRequest({
      base64Data: "abc123",
      mediaType: "image/jpeg",
      widthInPixels: 640,
      heightInPixels: 400,
      label: "book a demo button",
      hint: { x: 320, y: 188 },
    });
    const blocks = request.messages[0]!.content as Exclude<
      (typeof request.messages)[0]["content"],
      string
    >;
    const text = (blocks[1] as { text: string }).text;
    expect(text).toContain("(320, 188)");
    expect(text).toContain("nearest that estimate");
  });
});

describe("parseMarkRefinementReply", () => {
  it("reads a clean canonical RECT reply", () => {
    expect(parseMarkRefinementReply("[RECT:100,60,220,104:button]", 640, 400)).toEqual({
      left: 100,
      top: 60,
      right: 220,
      bottom: 104,
    });
  });

  it("reads a tag surrounded by prose the model added anyway", () => {
    const reply = "the element is here: [RECT: 100, 60, 220, 104] hope that helps!";
    expect(parseMarkRefinementReply(reply, 640, 400)).toEqual({
      left: 100,
      top: 60,
      right: 220,
      bottom: 104,
    });
  });

  it("orders swapped corners and clamps a slightly-out-of-bounds box to the crop", () => {
    expect(parseMarkRefinementReply("[RECT:660,104,100,-10]", 640, 400)).toEqual({
      left: 100,
      top: 0,
      right: 639,
      bottom: 104,
    });
  });

  it("returns null for an explicit [NONE]", () => {
    expect(parseMarkRefinementReply("[NONE]", 640, 400)).toBeNull();
  });

  it("returns null for prose with no tag, and for an unparseable bracket", () => {
    expect(parseMarkRefinementReply("i cannot find it", 640, 400)).toBeNull();
    expect(parseMarkRefinementReply("[RECT:100,60]", 640, 400)).toBeNull();
  });

  it("returns null for a box spanning essentially the whole crop (failed grounding)", () => {
    expect(parseMarkRefinementReply("[RECT:2,2,636,396]", 640, 400)).toBeNull();
  });

  it("returns null for a degenerate box below the minimum element size", () => {
    expect(parseMarkRefinementReply("[RECT:100,60,101,61]", 640, 400)).toBeNull();
  });

  it("skips a non-rect tag and reads the first RECT that follows", () => {
    const reply = "[CIRCLE:50,50,10:x] [RECT:100,60,220,104]";
    expect(parseMarkRefinementReply(reply, 640, 400)).toEqual({
      left: 100,
      top: 60,
      right: 220,
      bottom: 104,
    });
  });
});
