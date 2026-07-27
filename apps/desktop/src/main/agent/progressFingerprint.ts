// Pure helper for the Screen Agent's no-progress detector (M2-03). It answers "did the screen
// change in a way the agent cares about?" - deliberately NOT "are the bytes identical?". A
// byte-exact hash is useless for this: a text editor's caret blinks and the menu-bar clock
// ticks, so the raw frame differs on almost every capture even when nothing moved, which made
// the detector reset every step and never trip - letting a stuck model loop indefinitely.
//
// The frame is downscaled to a small square grid and each cell's brightness is bucketed
// coarsely, so a blinking caret or a ticking clock (a sub-cell, low-contrast change) survives
// quantization unchanged and consecutive "nothing happened" frames fingerprint identically,
// while a scroll, a new window, or typed text shifts whole cells and reads as real progress.
//
// This module is kept pure (no electron, no image decoding) so the quantization is unit-tested
// against synthetic bitmaps; the nativeImage decode + resize lives in the service that calls it.

/** The side length of the coarse grid a frame is downscaled to before fingerprinting. */
export const PROGRESS_GRID = 16;

/**
 * Reduces a row-major BGRA bitmap (already downscaled to a small grid) to a fingerprint string:
 * each pixel becomes a Rec. 601 luma bucketed to its top 3 bits (8 brightness levels), so a
 * small-contrast change within a cell does not flip its bucket. Two frames that differ only by
 * such noise fingerprint identically; a real layout change flips cells and differs.
 */
export function fingerprintBitmap(bitmap: Uint8Array): string {
  let fingerprint = "";
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const luma = (bitmap[offset + 2]! * 77 + bitmap[offset + 1]! * 150 + bitmap[offset]! * 29) >> 8;
    fingerprint += (luma >> 5).toString(16);
  }
  return fingerprint;
}
