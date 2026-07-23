/**
 * Reads a finished answer's trailing Point Tag. Where the canonicalizer
 * ({@link ./pointTagCanonicalizer}) *repairs* a model's sloppy tag into the exact
 * canonical grammar, this parser *reads* that canonical form back out: it splits the
 * answer into the clean human text the Overlay's response bubble shows and the
 * pointing directive the Overlay acts on.
 *
 * Living in the Core keeps the tag grammar owned in one place (developer story: the
 * Point Tag grammar is Core-owned and Vendor-independent). It is pure and
 * transport-agnostic, so both the Electron main process (mapping the point onto a
 * real display) and any future Shell read the same split.
 *
 * The canonical grammar - always the last thing in the answer:
 *
 *   [POINT:x,y:label]            point on the cursor's screen
 *   [POINT:x,y:label:screenN]    point on another screen
 *   [POINT:none]                 pointing wouldn't help
 */

/** A parsed pointing target: model coordinates in real screenshot-pixel space. */
export interface ParsedPoint {
  /** The x coordinate in the target screenshot's captured-pixel space. */
  x: number;
  /** The y coordinate in the target screenshot's captured-pixel space. */
  y: number;
  /** The short human label the model attached to the target ("Save button"). */
  label: string;
  /**
   * The 1-based screen the coordinates belong to, or `null` when the tag omitted a
   * screen - meaning the cursor's screen (screen 1), the model's primary focus.
   */
  screenNumber: number | null;
}

/**
 * What the answer asked the Overlay to do:
 *   - `point`  - fly to and point at {@link ParsedPoint}.
 *   - `none`   - the model emitted `[POINT:none]`: pointing wouldn't help, so the
 *                cursor stays put (distinct from never having considered it).
 *   - `absent` - no tag at all (e.g. a Vendor that didn't emit one).
 */
export type PointDirective =
  | { kind: "point"; point: ParsedPoint }
  | { kind: "none" }
  | { kind: "absent" };

/** The answer split into what the user reads and what the Overlay acts on. */
export interface ParsedAnswer {
  /** The answer with the trailing Point Tag removed and trailing whitespace trimmed. */
  displayText: string;
  /** The pointing directive carried by the trailing tag. */
  directive: PointDirective;
}

// Matches a trailing Point Tag (the last thing in the answer, tolerating trailing
// whitespace). The inner group is parsed separately so the coordinate/label/screen
// grammar lives in one readable place rather than a single dense pattern. Anchored to
// the end so a bracket earlier in the prose (a code snippet, an array literal) is
// never mistaken for a directive.
const TRAILING_POINT_TAG = /\[\s*point\s*:\s*([^\]]*)\]\s*$/i;

/**
 * Parses the coordinate/label/screen body of a `[POINT:...]` tag (everything the
 * canonicalizer places between the brackets). Returns `null` when the body is the
 * `none` sentinel or has no recoverable coordinate pair, so the caller can tell a
 * real point from the no-point case.
 */
function parsePointBody(tagBody: string): ParsedPoint | null {
  const body = tagBody.trim();
  if (/^none$/i.test(body)) {
    return null;
  }

  // Canonical order is `x,y:label` optionally followed by `:screenN`. Pull the
  // leading coordinate pair, then read the label and optional screen from the rest.
  const coordinateMatch = body.match(/^(-?\d+)\s*,\s*(-?\d+)/);
  if (coordinateMatch === null) {
    return null;
  }

  const x = Number.parseInt(coordinateMatch[1], 10);
  const y = Number.parseInt(coordinateMatch[2], 10);

  const afterCoordinates = body.slice(coordinateMatch[0].length);
  // The remaining colon-separated parts are the label and (optionally) `screenN`.
  const trailingParts = afterCoordinates
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  let screenNumber: number | null = null;
  const labelParts: string[] = [];
  for (const part of trailingParts) {
    const screenMatch = part.match(/^screen\s*(\d+)$/i);
    if (screenMatch !== null) {
      screenNumber = Number.parseInt(screenMatch[1], 10);
    } else {
      labelParts.push(part);
    }
  }

  return { x, y, label: labelParts.join(" "), screenNumber };
}

/**
 * Splits an answer into its clean display text and its pointing directive. The tag
 * (when present) is always the last thing in the answer, so anything before it is the
 * human answer and is returned with trailing whitespace trimmed.
 */
export function parseAnswerPointTag(answerText: string): ParsedAnswer {
  const tagMatch = answerText.match(TRAILING_POINT_TAG);
  if (tagMatch === null) {
    return { displayText: answerText, directive: { kind: "absent" } };
  }

  const displayText = answerText.slice(0, tagMatch.index).replace(/\s+$/, "");
  const point = parsePointBody(tagMatch[1]);
  const directive: PointDirective =
    point === null ? { kind: "none" } : { kind: "point", point };

  return { displayText, directive };
}
