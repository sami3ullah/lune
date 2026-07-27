import { describe, expect, it } from "vitest";

import { identityRemap, remapForScaleFactor } from "../src/reasoning/coordinateRemap";
import {
  canonicalizeShapeBracket,
  couldStartShapeTag,
  looksLikeShapeTag,
} from "../src/reasoning/shapeTagCanonicalizer";

/**
 * Unit tests for the Shape Tag canonicalizer: the teaching-overlay peer of the Point
 * Tag canonicalizer (M3-01). It repairs a Reasoning model's sloppy shape bracket into
 * the exact canonical form the Overlay parser matches, and remaps each coordinate from
 * downscaled space back into real screenshot pixels - unit-tested exactly like Point
 * Tags.
 */

describe("looksLikeShapeTag", () => {
  it("recognizes each shape keyword regardless of casing and spacing", () => {
    expect(looksLikeShapeTag("[CIRCLE:1,2,3:x]")).toBe(true);
    expect(looksLikeShapeTag("[ rect : 1,2,3,4 : x ]")).toBe(true);
    expect(looksLikeShapeTag("[Arrow:1,2,3,4:x]")).toBe(true);
    expect(looksLikeShapeTag("[line:1,2,3,4:x]")).toBe(true);
    expect(looksLikeShapeTag("[HIGHLIGHT:1,2,3,4:x]")).toBe(true);
  });

  it("does not mistake a point tag or ordinary bracket for a shape", () => {
    expect(looksLikeShapeTag("[POINT:1,2:x]")).toBe(false);
    expect(looksLikeShapeTag("[0]")).toBe(false);
  });
});

describe("couldStartShapeTag", () => {
  it("holds a bare bracket and any shape-keyword prefix", () => {
    expect(couldStartShapeTag("[")).toBe(true);
    expect(couldStartShapeTag("[ci")).toBe(true);
    expect(couldStartShapeTag("[high")).toBe(true);
  });

  it("does not hold a bracket that cannot become a shape", () => {
    expect(couldStartShapeTag("[about")).toBe(false);
    expect(couldStartShapeTag("[point")).toBe(false);
  });
});

describe("canonicalizeShapeBracket", () => {
  it("leaves a well-formed circle untouched under the identity remap", () => {
    const tag = "[CIRCLE:640,360,50:save button]";
    expect(canonicalizeShapeBracket(tag, identityRemap)).toBe(tag);
  });

  it("repairs a circle's casing, spacing, and separators into the canonical form", () => {
    const sloppy = "[ Circle : 640 , 360 , 50 : save button ]";
    expect(canonicalizeShapeBracket(sloppy, identityRemap)).toBe("[CIRCLE:640,360,50:save button]");
  });

  it("remaps a circle's center and radius from downscaled space to real pixels", () => {
    const remap = remapForScaleFactor(0.5);
    expect(canonicalizeShapeBracket("[CIRCLE:320,180,40:the button]", remap)).toBe(
      "[CIRCLE:640,360,80:the button]",
    );
  });

  it("remaps both corners of a rectangle", () => {
    const remap = remapForScaleFactor(0.5);
    expect(canonicalizeShapeBracket("[RECT:10,20,110,220:a box]", remap)).toBe(
      "[RECT:20,40,220,440:a box]",
    );
  });

  it("remaps both endpoints of an arrow and keeps the screen number", () => {
    const remap = remapForScaleFactor(0.5);
    expect(canonicalizeShapeBracket("[arrow:100,100,200,200:from a to b:screen2]", remap)).toBe(
      "[ARROW:200,200,400,400:from a to b:screen2]",
    );
  });

  it("rounds float coordinates to integers", () => {
    // Math.round is half-up, matching the Point Tag canonicalizer: 0.6 -> 1, 10.5 -> 11.
    expect(canonicalizeShapeBracket("[LINE:0.4,0.6,10.5,20.5:edge]", identityRemap)).toBe(
      "[LINE:0,1,11,21:edge]",
    );
  });

  it("normalizes stroke, fill, and color modifiers into canonical order", () => {
    const sloppy = "[ Circle : 640,360,50 : save button : Red : Filled : Dotted : screen2 ]";
    // Canonical order is stroke, fill, color, screen - regardless of the input order.
    expect(canonicalizeShapeBracket(sloppy, identityRemap)).toBe(
      "[CIRCLE:640,360,50:save button:dotted:filled:red:screen2]",
    );
  });

  it("accepts a hex color and drops defaulted modifiers", () => {
    // "solid" and "hollow" are the defaults, so they never appear in the output.
    expect(
      canonicalizeShapeBracket("[RECT:0,0,10,10:box:solid:hollow:#FF0000]", identityRemap),
    ).toBe("[RECT:0,0,10,10:box:#ff0000]");
  });

  it("accepts the full word 'rectangle' and normalizes it to RECT", () => {
    expect(canonicalizeShapeBracket("[rectangle:0,0,10,10:a box]", identityRemap)).toBe(
      "[RECT:0,0,10,10:a box]",
    );
  });

  it("supports a highlight region", () => {
    expect(canonicalizeShapeBracket("[HIGHLIGHT:5,5,120,40:this line:yellow]", identityRemap)).toBe(
      "[HIGHLIGHT:5,5,120,40:this line:yellow]",
    );
  });

  it("keeps a label that is itself a style or color word (first segment is the label)", () => {
    // Circling the literal text "red" on screen: "red" is the label, not a color.
    expect(canonicalizeShapeBracket("[CIRCLE:1,2,3:red]", identityRemap)).toBe(
      "[CIRCLE:1,2,3:red]",
    );
    // And it still reads a real color when it follows the label.
    expect(canonicalizeShapeBracket("[CIRCLE:1,2,3:the red word:blue]", identityRemap)).toBe(
      "[CIRCLE:1,2,3:the red word:blue]",
    );
  });

  it("reads the screen number even when the label is omitted", () => {
    // screenN is unambiguous, so it is recognized in any position - here with no label.
    expect(canonicalizeShapeBracket("[ARROW:0,0,5,5:screen2]", identityRemap)).toBe(
      "[ARROW:0,0,5,5::screen2]",
    );
  });

  it("leaves a shape with too few coordinates unchanged (not repairable)", () => {
    // A rectangle needs four numbers; with only two there is nothing to draw.
    const broken = "[RECT:10,20:a box]";
    expect(canonicalizeShapeBracket(broken, identityRemap)).toBe(broken);
  });

  it("does not consume label numbers as coordinates", () => {
    // The two coordinates are consumed as the corners; "step 2" stays the label.
    expect(canonicalizeShapeBracket("[LINE:0,0,10,10:step 2]", identityRemap)).toBe(
      "[LINE:0,0,10,10:step 2]",
    );
  });
});
