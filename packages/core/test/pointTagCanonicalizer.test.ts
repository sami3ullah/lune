import { describe, expect, it } from "vitest";

import {
  PointTagStreamGuard,
  canonicalizeTrailingPointTag,
  identityRemap,
  remapForScaleFactor,
  type RemapCoordinate,
} from "../src/reasoning/pointTagCanonicalizer";

/**
 * Unit tests for the Point Tag canonicalizer: the output sanitizer that repairs a
 * Reasoning model's `[POINT:...]` tags into the exact canonical form the Overlay
 * parser matches, and the coordinate remap that inverts the screenshot downscale.
 * Carried from v1's Sidecar suite unchanged.
 */

/** Collects everything a guard emits when fed the chunks, then finalized. */
function runGuard(chunks: string[], remap: RemapCoordinate): string {
  const guard = new PointTagStreamGuard(remap);
  let emitted = "";
  for (const chunk of chunks) {
    emitted += guard.push(chunk);
  }
  emitted += guard.finalize();
  return emitted;
}

describe("remapForScaleFactor", () => {
  it("maps a downscaled coordinate back to real screenshot pixels", () => {
    const remap = remapForScaleFactor(0.5);
    expect(remap(320, 180)).toEqual({ x: 640, y: 360 });
  });

  it("is the identity for a factor of 1 or a nonsensical factor", () => {
    expect(remapForScaleFactor(1)(100, 200)).toEqual({ x: 100, y: 200 });
    expect(remapForScaleFactor(0)(100, 200)).toEqual({ x: 100, y: 200 });
    expect(remapForScaleFactor(Number.NaN)(100, 200)).toEqual({ x: 100, y: 200 });
  });
});

describe("canonicalizeTrailingPointTag", () => {
  it("leaves a well-formed tag untouched under the identity remap", () => {
    const text = "look at the toolbar [POINT:285,11:source control]";
    expect(canonicalizeTrailingPointTag(text, identityRemap)).toBe(text);
  });

  it("repairs spacing, casing, and separators into the canonical form", () => {
    const sloppy = "here it is [ point : 640 , 360 - Save Button ]";
    expect(canonicalizeTrailingPointTag(sloppy, identityRemap)).toBe(
      "here it is [POINT:640,360:Save Button]",
    );
  });

  it("rounds float coordinates to the integers the Overlay parser requires", () => {
    const withFloats = "there [POINT:12.4,99.8:menu]";
    expect(canonicalizeTrailingPointTag(withFloats, identityRemap)).toBe("there [POINT:12,100:menu]");
  });

  it("preserves the screen number for multi-screen pointing", () => {
    const sloppy = "over there [point:400,300:terminal:screen2]";
    expect(canonicalizeTrailingPointTag(sloppy, identityRemap)).toBe(
      "over there [POINT:400,300:terminal:screen2]",
    );
  });

  it("remaps coordinates from downscaled space into real screenshot pixels", () => {
    const remap = remapForScaleFactor(0.5);
    const downscaled = "click here [POINT:320,180:the Save button:screen1]";
    expect(canonicalizeTrailingPointTag(downscaled, remap)).toBe(
      "click here [POINT:640,360:the Save button:screen1]",
    );
  });

  it("canonicalizes the no-point case", () => {
    expect(canonicalizeTrailingPointTag("just chatting [POINT: none ]", identityRemap)).toBe(
      "just chatting [POINT:none]",
    );
  });

  it("leaves ordinary bracketed text alone", () => {
    const text = "the array index is arr[0] here";
    expect(canonicalizeTrailingPointTag(text, identityRemap)).toBe(text);
  });
});

describe("PointTagStreamGuard", () => {
  it("passes plain text straight through", () => {
    expect(runGuard(["hello ", "there, ", "how are you?"], identityRemap)).toBe(
      "hello there, how are you?",
    );
  });

  it("holds back and repairs a trailing tag split across chunks", () => {
    // The tag arrives byte-by-byte across several deltas, as a real stream would.
    const chunks = ["you'll want the save button. ", "[POINT:", "320,180", ":save:screen1", "]"];
    expect(runGuard(chunks, remapForScaleFactor(0.5))).toBe(
      "you'll want the save button. [POINT:640,360:save:screen1]",
    );
  });

  it("emits ordinary bracketed text without holding it to the end", () => {
    const chunks = ["the value is arr[0] ", "and that's it."];
    // Nothing here is a Point Tag, so it all flows through unchanged.
    expect(runGuard(chunks, identityRemap)).toBe("the value is arr[0] and that's it.");
  });

  it("does not emit the raw malformed tag before repairing it", () => {
    const guard = new PointTagStreamGuard(remapForScaleFactor(0.5));
    const emittedBeforeFinalize = guard.push("answer text [point: 320 , 180 : save ]");
    // The malformed tag must not have leaked out mid-stream; only the prose has.
    expect(emittedBeforeFinalize).toBe("answer text ");
    expect(emittedBeforeFinalize).not.toContain("point");
    // Finalizing yields the repaired, remapped tag.
    expect(emittedBeforeFinalize + guard.finalize()).toBe("answer text [POINT:640,360:save]");
  });
});
