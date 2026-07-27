import { describe, expect, it } from "vitest";

import { fingerprintBitmap } from "../src/main/agent/progressFingerprint";

/**
 * Unit tests for the no-progress fingerprint's pure quantization (M2-03). The point of the
 * fingerprint is that "the screen didn't meaningfully change" survives the pixel noise a real
 * screen always has - a blinking text caret, a ticking menu-bar clock - so the detector can
 * actually trip on a stuck run. A byte-exact hash could not: those change every frame. These
 * tests pin that down against synthetic BGRA bitmaps, with no image decoding.
 */

/** Builds a row-major BGRA bitmap of `count` pixels, each a flat gray of `value` (0-255). */
function grayBitmap(count: number, value: number): Uint8Array {
  const bytes = new Uint8Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    bytes[i * 4] = value; // B
    bytes[i * 4 + 1] = value; // G
    bytes[i * 4 + 2] = value; // R
    bytes[i * 4 + 3] = 255; // A
  }
  return bytes;
}

describe("fingerprintBitmap - coarse, noise-tolerant frame fingerprint", () => {
  it("is stable across a small-contrast change within a brightness bucket (the caret/clock case)", () => {
    // A near-white frame; one 'caret' pixel darkens slightly. A small shift inside the top
    // brightness bucket must not change the fingerprint - else the detector never trips.
    const base = grayBitmap(256, 250);
    const withCaret = grayBitmap(256, 250);
    withCaret[0] = 240; // B of pixel 0
    withCaret[1] = 240; // G
    withCaret[2] = 240; // R

    expect(fingerprintBitmap(withCaret)).toBe(fingerprintBitmap(base));
  });

  it("changes when a pixel crosses into another brightness bucket (real layout change)", () => {
    const base = grayBitmap(256, 250); // top bucket
    const changed = grayBitmap(256, 250);
    changed[0] = 20; // a cell goes from near-white to near-black (a scroll/new window)
    changed[1] = 20;
    changed[2] = 20;

    expect(fingerprintBitmap(changed)).not.toBe(fingerprintBitmap(base));
  });

  it("distinguishes two clearly different frames", () => {
    expect(fingerprintBitmap(grayBitmap(256, 250))).not.toBe(fingerprintBitmap(grayBitmap(256, 10)));
  });

  it("gives an identical frame an identical fingerprint (deterministic)", () => {
    const frame = grayBitmap(256, 128);
    expect(fingerprintBitmap(frame)).toBe(fingerprintBitmap(grayBitmap(256, 128)));
  });
});
