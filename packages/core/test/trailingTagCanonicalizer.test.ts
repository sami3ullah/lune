import { describe, expect, it } from "vitest";

import { identityRemap, remapForScaleFactor, type RemapCoordinate } from "../src/reasoning/coordinateRemap";
import {
  TrailingTagStreamGuard,
  canonicalizeTrailingTags,
} from "../src/reasoning/trailingTagCanonicalizer";

/**
 * Tests for the trailing-tag family's shared stream discipline: the run-canonicalizer
 * that repairs a whole trailing run of Point and Shape tags at once, and the stream
 * guard that holds those tags back until they are complete so a half-streamed tag never
 * reaches the Shell. The point-repair cases are carried from v1's Sidecar suite; the
 * shape and multi-tag cases are new for the teaching overlay (M3-01).
 */

/** Collects everything a guard emits when fed the chunks, then finalized. */
function runGuard(chunks: string[], remap: RemapCoordinate): string {
  const guard = new TrailingTagStreamGuard(remap);
  let emitted = "";
  for (const chunk of chunks) {
    emitted += guard.push(chunk);
  }
  emitted += guard.finalize();
  return emitted;
}

describe("canonicalizeTrailingTags", () => {
  it("leaves a well-formed point tag untouched under the identity remap", () => {
    const text = "look at the toolbar [POINT:285,11:source control]";
    expect(canonicalizeTrailingTags(text, identityRemap)).toBe(text);
  });

  it("repairs a point tag's spacing, casing, and separators into the canonical form", () => {
    const sloppy = "here it is [ point : 640 , 360 - Save Button ]";
    expect(canonicalizeTrailingTags(sloppy, identityRemap)).toBe(
      "here it is [POINT:640,360:Save Button]",
    );
  });

  it("rounds float coordinates to the integers the Overlay parser requires", () => {
    const withFloats = "there [POINT:12.4,99.8:menu]";
    expect(canonicalizeTrailingTags(withFloats, identityRemap)).toBe("there [POINT:12,100:menu]");
  });

  it("preserves the screen number for multi-screen pointing", () => {
    const sloppy = "over there [point:400,300:terminal:screen2]";
    expect(canonicalizeTrailingTags(sloppy, identityRemap)).toBe(
      "over there [POINT:400,300:terminal:screen2]",
    );
  });

  it("remaps point coordinates from downscaled space into real screenshot pixels", () => {
    const remap = remapForScaleFactor(0.5);
    const downscaled = "click here [POINT:320,180:the Save button:screen1]";
    expect(canonicalizeTrailingTags(downscaled, remap)).toBe(
      "click here [POINT:640,360:the Save button:screen1]",
    );
  });

  it("canonicalizes the no-point case", () => {
    expect(canonicalizeTrailingTags("just chatting [POINT: none ]", identityRemap)).toBe(
      "just chatting [POINT:none]",
    );
  });

  it("leaves ordinary bracketed text alone", () => {
    const text = "the array index is arr[0] here";
    expect(canonicalizeTrailingTags(text, identityRemap)).toBe(text);
  });

  it("repairs and remaps a run of shape tags followed by a point tag", () => {
    // A teaching turn: circle a thing, arrow to another, then point. All coordinates
    // are in downscaled space and must all come out doubled.
    const remap = remapForScaleFactor(0.5);
    const turn =
      "watch this [CIRCLE:100,100,20:the source:dotted:red] [ARROW:100,100,200,200:it flows here] [POINT:200,200:the target]";
    expect(canonicalizeTrailingTags(turn, remap)).toBe(
      "watch this [CIRCLE:200,200,40:the source:dotted:red] [ARROW:200,200,400,400:it flows here] [POINT:400,400:the target]",
    );
  });
});

describe("TrailingTagStreamGuard", () => {
  it("passes plain text straight through", () => {
    expect(runGuard(["hello ", "there, ", "how are you?"], identityRemap)).toBe(
      "hello there, how are you?",
    );
  });

  it("holds back and repairs a trailing point tag split across chunks", () => {
    // The tag arrives byte-by-byte across several deltas, as a real stream would.
    const chunks = ["you'll want the save button. ", "[POINT:", "320,180", ":save:screen1", "]"];
    expect(runGuard(chunks, remapForScaleFactor(0.5))).toBe(
      "you'll want the save button. [POINT:640,360:save:screen1]",
    );
  });

  it("holds back and repairs a trailing shape tag split across chunks", () => {
    const chunks = ["circling it now. ", "[CIR", "CLE:320,180", ",40:the button", ":dotted]"];
    expect(runGuard(chunks, remapForScaleFactor(0.5))).toBe(
      "circling it now. [CIRCLE:640,360,80:the button:dotted]",
    );
  });

  it("emits ordinary bracketed text without holding it to the end", () => {
    const chunks = ["the value is arr[0] ", "and that's it."];
    // Nothing here is a trailing tag, so it all flows through unchanged.
    expect(runGuard(chunks, identityRemap)).toBe("the value is arr[0] and that's it.");
  });

  it("does not emit a raw malformed shape tag before repairing it", () => {
    const guard = new TrailingTagStreamGuard(remapForScaleFactor(0.5));
    const emittedBeforeFinalize = guard.push("here you go [ circle : 320 , 180 , 40 : save ]");
    // The malformed tag must not have leaked out mid-stream; only the prose has.
    expect(emittedBeforeFinalize).toBe("here you go ");
    expect(emittedBeforeFinalize.toLowerCase()).not.toContain("circle");
    // Finalizing yields the repaired, remapped tag.
    expect(emittedBeforeFinalize + guard.finalize()).toBe("here you go [CIRCLE:640,360,80:save]");
  });

  it("holds an ambiguous open bracket that could still become a shape tag", () => {
    const guard = new TrailingTagStreamGuard(identityRemap);
    // "[a" could be the start of "[ARROW...]"; hold it rather than leaking a partial tag.
    expect(guard.push("draw it [a")).toBe("draw it ");
    // It resolves into a real arrow once the rest streams in.
    expect(guard.push("rrow:0,0,5,5:over here]")).toBe("");
    expect(guard.finalize()).toBe("[ARROW:0,0,5,5:over here]");
  });
});
