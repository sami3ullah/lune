import { describe, expect, it } from "vitest";

import { identityRemap, remapForScaleFactor } from "../src/reasoning/coordinateRemap";

/**
 * Unit tests for the coordinate remap: the inverse-downscale math that maps a model's
 * coordinate (in the space of the downscaled screenshot it saw) back into real
 * screenshot pixels. Both Point Tags and Shape Tags run their coordinates through it.
 * Carried from v1's Sidecar suite unchanged.
 */

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

  it("the identity remap returns its input unchanged", () => {
    expect(identityRemap(42, 7)).toEqual({ x: 42, y: 7 });
  });
});
