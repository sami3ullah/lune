/**
 * Coordinate remapping: inverts the screenshot downscale a Reasoning request applied
 * before sending an image to a Vendor, mapping a model coordinate (in the downscaled
 * space the model saw) back into real screenshot-pixel space.
 *
 * Both Point Tags and Shape Tags run their coordinates through this same remap, so it
 * lives in its own leaf module - imported by every tag canonicalizer and by the
 * reasoning pipeline that builds the remap from a request's scale factor. Pure and
 * transport-agnostic. Carried from v1's Sidecar (`reasoning/pointTagCanonicalizer.ts`).
 */

/** Maps a coordinate from the (downscaled) space the model saw into real screenshot pixels. */
export type RemapCoordinate = (x: number, y: number) => { x: number; y: number };

/** The identity remap, for the no-downscale (passthrough) case. */
export const identityRemap: RemapCoordinate = (x, y) => ({ x, y });

/**
 * Builds a remap that inverts a uniform downscale: a model coordinate in
 * downscaled space is divided by the scale factor to recover the real
 * screenshot-pixel coordinate. `scaleFactor` is the downscaled-to-original ratio
 * (e.g. 0.5 for a halved image); 1.0 yields the identity. Guards against a zero
 * or non-finite factor by falling back to identity so a bad factor never produces
 * NaN coordinates.
 */
export function remapForScaleFactor(scaleFactor: number): RemapCoordinate {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor === 1) {
    return identityRemap;
  }
  return (x, y) => ({
    x: Math.round(x / scaleFactor),
    y: Math.round(y / scaleFactor),
  });
}
