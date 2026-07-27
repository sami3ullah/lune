/**
 * Reads a finished answer's trailing Shape Tags. The teaching-overlay counterpart of
 * {@link ./pointTagParser}: where the canonicalizer ({@link ./shapeTagCanonicalizer})
 * *repairs* a model's sloppy shape tags into the exact canonical grammar, this parser
 * *reads* that canonical form back out - splitting the answer into the clean human text
 * the Overlay's bubble shows and the list of shapes the Overlay draws.
 *
 * Living in the Core keeps the tag grammar owned in one place (the Shape Tag grammar is
 * Core-owned and Vendor-independent, like the Point Tag). It is pure and
 * transport-agnostic, so the Electron main process reads the same split.
 *
 * Shape tags trail the spoken text and sit *before* any Point Tag or Act Tag (the
 * grammar the canonical system prompt teaches), so a caller that also reads those tags
 * strips them first (Act, then Point) and passes the remainder here - at which point the
 * shape tags are the trailing content this parser reads. Coordinates are the real
 * screenshot-pixel values the canonicalizer already remapped; turning them into a point
 * on the correct monitor is the Shell's half (`overlayGeometry`).
 */
import {
  RECOGNIZED_SHAPE_KEYWORDS,
  parseShapeTagBody,
  type ShapeKind,
  type ShapeStyle,
  type ShapeTagBody,
} from "./shapeTagCanonicalizer.js";

/** A point in the target screenshot's captured-pixel space. */
export interface ShapePoint {
  x: number;
  y: number;
}

/**
 * One parsed shape to draw. Coordinates are uniform across kinds: `points` holds the
 * shape's defining points in captured-pixel space - `[center]` for a circle (with its
 * `radius`), `[start, end]` for every two-point shape (rect/highlight/arrow/line, with
 * `radius` null) - so the Shell can remap every point the same way regardless of kind.
 */
export interface ParsedShape {
  kind: ShapeKind;
  points: ShapePoint[];
  /** The circle radius in captured pixels, or null for a non-circle shape. */
  radius: number | null;
  /** The short phrase the model attached ("save button"), possibly empty. */
  label: string;
  style: ShapeStyle;
  /**
   * The 1-based screen the shape belongs to, or null when the tag omitted a screen -
   * meaning the cursor's screen (screen 1), exactly like a Point Tag.
   */
  screenNumber: number | null;
}

/** The answer split into what the user reads and the shapes the Overlay draws. */
export interface ParsedShapeAnswer {
  /** The answer with the trailing Shape Tags removed and trailing whitespace trimmed. */
  displayText: string;
  /** The shapes to draw, in the order the model emitted them. */
  shapes: ParsedShape[];
}

// Matches a single trailing Shape Tag (the last bracket in the text, tolerating trailing
// whitespace). Anchored to the end so a bracket earlier in the prose is never mistaken for
// a shape; the loop below peels them off one at a time from the end.
const TRAILING_SHAPE_TAG = new RegExp(
  `(\\[\\s*(?:${RECOGNIZED_SHAPE_KEYWORDS.join("|")})\\b[^\\]]*\\])\\s*$`,
  "i",
);

/** Turns a parsed tag body into the uniform points+radius shape the Overlay draws. */
function toParsedShape(body: ShapeTagBody): ParsedShape {
  const common = { kind: body.kind, label: body.label, style: body.style, screenNumber: body.screenNumber };
  if (body.kind === "circle") {
    const [x, y, radius] = body.numbers;
    return { ...common, points: [{ x, y }], radius };
  }
  const [x1, y1, x2, y2] = body.numbers;
  return { ...common, points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], radius: null };
}

/**
 * Splits an answer into its clean display text and the shapes it draws. Shape tags are the
 * trailing content (after the Act and Point tags are stripped), so this peels them off the
 * end one at a time - preserving the model's order - and returns the remaining prose with
 * trailing whitespace trimmed. A trailing shape-like bracket that can't be parsed (missing
 * coordinates) is left in the text rather than dropped, so nothing is silently lost.
 */
export function parseAnswerShapeTags(answerText: string): ParsedShapeAnswer {
  let remaining = answerText;
  const shapes: ParsedShape[] = [];

  for (;;) {
    const match = remaining.match(TRAILING_SHAPE_TAG);
    if (match === null) {
      break;
    }
    const body = parseShapeTagBody(match[1]);
    if (body === null) {
      break;
    }
    shapes.unshift(toParsedShape(body));
    remaining = remaining.slice(0, match.index).replace(/\s+$/, "");
  }

  return { displayText: remaining, shapes };
}
