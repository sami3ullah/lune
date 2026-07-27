/**
 * Point Tag canonicalization: repairs a Reasoning model's `[POINT:...]` bracket into
 * the exact canonical form the Shell's Overlay parser matches, and remaps the model's
 * downscaled-space coordinates back into real screenshot-pixel space.
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
 * where x,y are integers and label contains no `:` or `]`.
 *
 * The Point Tag is one member of the trailing-tag family: the stream guard that holds
 * these tags back until complete, and the run-canonicalizer that repairs a whole
 * trailing run of them, live in {@link ./trailingTagCanonicalizer}; Shape Tags are the
 * Point Tag's peer in {@link ./shapeTagCanonicalizer}. This module owns only the
 * Point-specific bracket grammar, exported so the guard can recognize and repair it.
 *
 * Carried from v1's Sidecar (`reasoning/pointTagCanonicalizer.ts`): it is pure and
 * transport-agnostic, so it ports into the Core verbatim.
 */
import type { RemapCoordinate } from "./coordinateRemap.js";

/** True if `bracketSegment` (a complete `[...]`) looks like it starts a Point Tag. */
export function looksLikePointTag(bracketSegment: string): boolean {
  return /^\[\s*point\b/i.test(bracketSegment);
}

/**
 * True if `text` (which starts with `[`) could still grow into a Point Tag as more
 * characters stream in - i.e. what we have after the `[` is either the full "point"
 * keyword or a prefix of it. This is what decides whether an as-yet-unclosed
 * bracket is held back or flushed.
 */
export function couldStartPointTag(text: string): boolean {
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
export function canonicalizePointBracket(bracketSegment: string, remap: RemapCoordinate): string {
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
