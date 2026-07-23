/**
 * Point Tag canonicalization: repairs a Reasoning model's `[POINT:...]` tags into
 * the exact canonical form the Shell's Overlay parser matches, and remaps the
 * model's downscaled-space coordinates back into real screenshot-pixel space.
 *
 * A capable cloud Vendor follows the tag grammar reliably, but the Core repairs
 * output rather than trusting it - the same sanitizer that let a small local model
 * behave in v1 keeps every Vendor's output identical to the Shell. The canonical
 * form the Shell expects is:
 *
 *   [POINT:x,y:label]            element on the cursor's screen
 *   [POINT:x,y:label:screenN]    element on another screen
 *   [POINT:none]                 pointing wouldn't help
 *
 * where x,y are integers and label contains no `:` or `]`. The Overlay's parser
 * also requires the tag to be the last thing in the response, so the tag must be
 * emitted intact at the very end - which is why streaming needs the guard below.
 *
 * Carried from v1's Sidecar (`reasoning/pointTagCanonicalizer.ts`) unchanged: it is
 * pure and transport-agnostic, so it ports into the Core verbatim.
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

/** True if `bracketSegment` (a complete `[...]`) looks like it starts a Point Tag. */
function looksLikePointTag(bracketSegment: string): boolean {
  return /^\[\s*point\b/i.test(bracketSegment);
}

/**
 * True if `text` (which starts with `[`) could still grow into a Point Tag as more
 * characters stream in - i.e. what we have after the `[` is either the full "point"
 * keyword or a prefix of it. This is what decides whether an as-yet-unclosed
 * bracket is held back or flushed.
 */
function couldStartPointTag(text: string): boolean {
  const afterBracket = text.replace(/^\[\s*/, "").toLowerCase();
  const keyword = "point";
  return afterBracket.startsWith(keyword) || keyword.startsWith(afterBracket);
}

/**
 * Canonicalizes a single Point-Tag-like bracket segment (e.g. `[ point: 640 , 360
 * - Save Button : Screen 2 ]`) into the exact form the Overlay parser matches,
 * remapping the coordinates. Returns `[POINT:none]` for the no-point case. If the
 * segment has no recoverable coordinates and isn't the none case, it is returned
 * unchanged (there is nothing to repair into a valid tag).
 */
function canonicalizePointBracket(bracketSegment: string, remap: RemapCoordinate): string {
  // Strip the surrounding brackets and normalize whitespace.
  const inner = bracketSegment.replace(/^\[/, "").replace(/\]$/, "").trim();

  // The "no point" case: [POINT:none], tolerating spacing/casing/separators.
  if (/^point\s*[:=-]?\s*none$/i.test(inner)) {
    return "[POINT:none]";
  }

  // Find the "x , y" coordinate pair anywhere after the POINT keyword. Accept
  // floats (a sloppy model may emit "640.0") and round to the integers the Overlay
  // parser requires.
  const coordinateMatch = inner.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (coordinateMatch === null) {
    // Not repairable into a coordinate tag; leave it as the model wrote it.
    return bracketSegment;
  }

  const modelX = Math.round(Number.parseFloat(coordinateMatch[1]));
  const modelY = Math.round(Number.parseFloat(coordinateMatch[2]));
  const remapped = remap(modelX, modelY);

  // Everything after the coordinate pair holds the label and optional screen,
  // separated (in the canonical form) by colons - but a sloppy model may use
  // other separators, so split permissively on ':' and pull out the screen.
  const afterCoordinates = inner.slice(coordinateMatch.index! + coordinateMatch[0].length);
  const trailingParts = afterCoordinates
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  let screenNumber: number | undefined;
  const labelParts: string[] = [];
  for (const part of trailingParts) {
    const screenMatch = part.match(/^screen\s*(\d+)$/i);
    if (screenMatch !== null) {
      screenNumber = Number.parseInt(screenMatch[1], 10);
    } else {
      // Strip any stray leading separator characters a model might have used
      // (e.g. a dash before the label) so the label never starts with junk.
      labelParts.push(part.replace(/^[\s:=-]+/, "").trim());
    }
  }

  // The label must not contain ':' or ']' (the Overlay regex forbids them); joining
  // the colon-split parts with a space keeps it clean and readable.
  const label = labelParts.join(" ").replace(/[:\]]/g, "").trim();
  const screenSuffix = screenNumber !== undefined ? `:screen${screenNumber}` : "";
  return `[POINT:${remapped.x},${remapped.y}:${label}${screenSuffix}]`;
}

/**
 * Canonicalizes the trailing text of a response: if it contains a Point Tag, the
 * tag is repaired and its coordinates remapped in place; otherwise the text is
 * returned unchanged. Used to finalize the buffered tail once the whole answer has
 * streamed.
 */
export function canonicalizeTrailingPointTag(trailingText: string, remap: RemapCoordinate): string {
  const openIndex = trailingText.indexOf("[");
  if (openIndex === -1) {
    return trailingText;
  }
  const closeIndex = trailingText.indexOf("]", openIndex);
  if (closeIndex === -1) {
    return trailingText;
  }

  const bracketSegment = trailingText.slice(openIndex, closeIndex + 1);
  if (!looksLikePointTag(bracketSegment)) {
    return trailingText;
  }

  const before = trailingText.slice(0, openIndex);
  const after = trailingText.slice(closeIndex + 1);
  return before + canonicalizePointBracket(bracketSegment, remap) + after;
}

/**
 * A streaming guard that lets response text flow through promptly (so sentence
 * streaming keeps first-audio latency low) while holding back the trailing Point
 * Tag until it is complete - because the tag must be emitted intact, repaired, and
 * remapped at the very end, and once events are streamed to the Shell they cannot
 * be unsent.
 *
 * `push` returns the portion of the accumulated text that is safe to emit now;
 * `finalize` returns the remaining held-back tail with any Point Tag canonicalized.
 */
export class PointTagStreamGuard {
  private buffer = "";

  constructor(private readonly remap: RemapCoordinate) {}

  /** Appends a chunk of model text and returns the prefix that is safe to emit now. */
  push(chunk: string): string {
    this.buffer += chunk;
    let emittable = "";

    for (;;) {
      const openIndex = this.buffer.indexOf("[");
      if (openIndex === -1) {
        // No open bracket at all: everything is safe to emit.
        emittable += this.buffer;
        this.buffer = "";
        break;
      }

      // Emit everything before the bracket; keep the bracket and what follows.
      emittable += this.buffer.slice(0, openIndex);
      this.buffer = this.buffer.slice(openIndex);

      const closeIndex = this.buffer.indexOf("]");
      if (closeIndex === -1) {
        // Incomplete bracket. If it could still become a Point Tag, hold it back
        // until it completes (or the stream ends). If it clearly can't, emit it so
        // ordinary unclosed text like "cost is [about" isn't stuck forever - but
        // only once it's long enough to be sure it isn't a Point-Tag prefix.
        if (couldStartPointTag(this.buffer)) {
          break;
        }
        emittable += this.buffer;
        this.buffer = "";
        break;
      }

      const bracketSegment = this.buffer.slice(0, closeIndex + 1);
      if (looksLikePointTag(bracketSegment)) {
        // A complete Point Tag: hold it (and anything after) back for finalize,
        // where it is repaired and remapped.
        break;
      }

      // A complete non-Point bracket (e.g. "[0]"): emit it and keep scanning.
      emittable += bracketSegment;
      this.buffer = this.buffer.slice(closeIndex + 1);
    }

    return emittable;
  }

  /** Returns the held-back tail with any Point Tag canonicalized and remapped. */
  finalize(): string {
    const tail = this.buffer;
    this.buffer = "";
    return canonicalizeTrailingPointTag(tail, this.remap);
  }
}
