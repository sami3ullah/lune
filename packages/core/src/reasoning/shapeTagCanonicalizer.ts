/**
 * Shape Tag canonicalization: the teaching-overlay peer of the Point Tag. Where a
 * Point Tag flies the cursor to one spot, a Shape Tag tells the Overlay to *draw* on
 * screen while Lune explains - a circle, rectangle, highlight, arrow, or line - so
 * every Reasoning Vendor gets drawing for free and its coordinates go through the same
 * proven remap pipeline as pointing.
 *
 * This module repairs a model's sloppy shape bracket into the exact canonical grammar
 * the Overlay parser matches, and remaps each coordinate from the downscaled space the
 * model saw back into real screenshot pixels - mirroring {@link ./pointTagCanonicalizer}.
 * The stream guard that holds these tags back until complete and the run-canonicalizer
 * that repairs a whole trailing run live in {@link ./trailingTagCanonicalizer}; this
 * module owns only the Shape-specific bracket grammar.
 *
 * The canonical forms the Overlay expects:
 *
 *   [CIRCLE:x,y,r:label]                circle centered at (x,y) with radius r
 *   [RECT:x1,y1,x2,y2:label]            rectangle between two opposite corners
 *   [HIGHLIGHT:x1,y1,x2,y2:label]       highlighted region between two corners
 *   [ARROW:x1,y1,x2,y2:label]           arrow from (x1,y1) to (x2,y2)
 *   [LINE:x1,y1,x2,y2:label]            line between two points
 *
 * Any shape may carry style modifiers and a screen, each in its own colon segment
 * after the label, in the canonical order stroke, fill, color, screen:
 *
 *   [CIRCLE:640,360,50:save button:dotted:filled:red:screen2]
 *
 * where the coordinates are integers, `label` contains no `:` or `]`, a stroke is
 * `dotted` or `dashed` (solid is the default and omitted), `filled` appears only when
 * the shape is filled, and a color is a known name or a `#rrggbb`/`#rgb` hex. Pure and
 * transport-agnostic, exactly like the Point Tag canonicalizer.
 */
import type { RemapCoordinate } from "./coordinateRemap.js";

/** The canonical shape keywords the grammar emits, lowercase, in prompt-documented order. */
const SHAPE_KEYWORDS = ["circle", "rect", "highlight", "arrow", "line"] as const;

/** One shape the grammar understands (the canonical, alias-resolved kind). */
export type ShapeKind = (typeof SHAPE_KEYWORDS)[number];

/**
 * The keywords recognized on input, including aliases a sloppy model might reach for
 * ("rectangle" for "rect"), each mapped to its canonical type. Longer aliases must come
 * before the prefixes they contain so the recognition alternation matches greedily
 * (e.g. "rectangle" before "rect").
 */
const SHAPE_KEYWORD_ALIASES: Record<string, ShapeKind> = {
  circle: "circle",
  rectangle: "rect",
  rect: "rect",
  highlight: "highlight",
  arrow: "arrow",
  line: "line",
};

/**
 * Every keyword the grammar accepts on input (canonical kinds plus aliases), exported so
 * the reader ({@link ./shapeTagParser}) matches exactly the same set of trailing tags the
 * canonicalizer repairs.
 */
export const RECOGNIZED_SHAPE_KEYWORDS = Object.keys(SHAPE_KEYWORD_ALIASES);

/** How many leading coordinate numbers each shape carries: a circle is center+radius; the rest are two points. */
const SHAPE_COORDINATE_ARITY: Record<ShapeKind, number> = {
  circle: 3,
  rect: 4,
  highlight: 4,
  arrow: 4,
  line: 4,
};

// Style vocabularies. A sloppy model may pick any of these; the canonicalizer maps
// them onto the small canonical set the Overlay renders. Defaults (solid stroke, not
// filled, no explicit color) are omitted from the output so a plain shape stays terse.
const STROKE_KEYWORDS = new Set(["dotted", "dashed"]);
const SOLID_KEYWORDS = new Set(["solid"]);
const FILLED_KEYWORDS = new Set(["filled"]);
const HOLLOW_KEYWORDS = new Set(["hollow", "outline", "outlined", "unfilled"]);
const NAMED_COLORS = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "white",
  "black",
  "gray",
  "grey",
]);
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Matches the shape keyword at the very start of a bracket's inner text. */
const SHAPE_KEYWORD_PATTERN = new RegExp(`^(${RECOGNIZED_SHAPE_KEYWORDS.join("|")})\\b[\\s:=-]*`, "i");

/** True if `bracketSegment` (a complete `[...]`) looks like it starts a Shape Tag. */
export function looksLikeShapeTag(bracketSegment: string): boolean {
  return new RegExp(`^\\[\\s*(?:${RECOGNIZED_SHAPE_KEYWORDS.join("|")})\\b`, "i").test(bracketSegment);
}

/**
 * True if `text` (which starts with `[`) could still grow into a Shape Tag as more
 * characters stream in - what we have after the `[` is either a full shape keyword or
 * a prefix of one. Mirrors the Point Tag's `couldStartPointTag` so the stream guard
 * treats every trailing-tag keyword the same way.
 */
export function couldStartShapeTag(text: string): boolean {
  const afterBracket = text.replace(/^\[\s*/, "").toLowerCase();
  return RECOGNIZED_SHAPE_KEYWORDS.some(
    (keyword) => afterBracket.startsWith(keyword) || keyword.startsWith(afterBracket),
  );
}

/** A shape's style modifiers. `solid`/not-filled/no-color are the defaults. */
export interface ShapeStyle {
  /** The stroke pattern: solid (default), dotted, or dashed. */
  stroke: "solid" | "dotted" | "dashed";
  /** Whether the shape is filled rather than an outline. */
  filled: boolean;
  /** An explicit color (a name or `#rrggbb`/`#rgb` hex), or null for the Overlay default. */
  color: string | null;
}

/**
 * A shape tag broken into its parts, shared by the canonicalizer (which remaps the
 * coordinates and re-renders the canonical string) and the reader ({@link
 * ./shapeTagParser}, which packages them for the Overlay). The coordinates are the raw
 * integers from the tag - in a canonical tag that is already real screenshot-pixel space;
 * mid-repair it is whatever the model wrote, which the canonicalizer then remaps.
 */
export interface ShapeTagBody {
  kind: ShapeKind;
  /** `[x, y, r]` for a circle; `[x1, y1, x2, y2]` for every other shape. */
  numbers: number[];
  label: string;
  style: ShapeStyle;
  /** The 1-based screen the shape belongs to, or null for the cursor's screen. */
  screenNumber: number | null;
}

/** Strips a stray leading separator a model might have left before a label word. */
function cleanLabelPart(part: string): string {
  return part.replace(/^[\s:=,-]+/, "").trim();
}

/**
 * Classifies the colon-separated parts after a shape's coordinates into the label,
 * style modifiers, and screen.
 *
 * The grammar puts the label first (`[TYPE:coords:label:modifiers...]`), so the first
 * part is always taken as the label - even when it happens to be a style or color word.
 * That matters for shapes in a way it doesn't for Point Tags: a legitimate 1-word label
 * like "red" (circling the text "red" on screen) must not be swallowed as a color. Only
 * the parts *after* the label are read as modifiers; `screenN` is unambiguous and so is
 * recognized in any position (including when the model omits the label entirely). An
 * unrecognized later part is appended to the label, tolerating a label a model split
 * across colons.
 */
function classifyTrailingParts(afterCoordinates: string): {
  label: string;
  style: ShapeStyle;
  screenNumber: number | null;
} {
  const parts = afterCoordinates
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const style: ShapeStyle = { stroke: "solid", filled: false, color: null };
  let screenNumber: number | null = null;
  const labelParts: string[] = [];

  parts.forEach((part, index) => {
    const lower = part.toLowerCase();
    const screenMatch = lower.match(/^screen\s*(\d+)$/);
    if (screenMatch !== null) {
      screenNumber = Number.parseInt(screenMatch[1], 10);
    } else if (index === 0) {
      // The first non-screen part is the label, verbatim, whatever word it is.
      labelParts.push(cleanLabelPart(part));
    } else if (STROKE_KEYWORDS.has(lower)) {
      style.stroke = lower as ShapeStyle["stroke"];
    } else if (SOLID_KEYWORDS.has(lower)) {
      style.stroke = "solid";
    } else if (FILLED_KEYWORDS.has(lower)) {
      style.filled = true;
    } else if (HOLLOW_KEYWORDS.has(lower)) {
      style.filled = false;
    } else if (NAMED_COLORS.has(lower)) {
      style.color = lower;
    } else if (HEX_COLOR.test(part)) {
      style.color = lower;
    } else {
      labelParts.push(cleanLabelPart(part));
    }
  });

  // The label must not contain ':' or ']' (the Overlay regex forbids them).
  const label = labelParts.join(" ").replace(/[:\]]/g, "").trim();
  return { label, style, screenNumber };
}

/** Renders the canonical `:stroke:filled:color` suffix, omitting defaulted modifiers. */
function renderStyleSuffix(style: ShapeStyle): string {
  const modifiers: string[] = [];
  if (style.stroke !== "solid") {
    modifiers.push(style.stroke);
  }
  if (style.filled) {
    modifiers.push("filled");
  }
  if (style.color !== null) {
    modifiers.push(style.color);
  }
  return modifiers.map((modifier) => `:${modifier}`).join("");
}

/**
 * Remaps a shape's coordinate numbers into real screenshot pixels and renders the
 * canonical `x,y[,...]` string. A circle's third number is a radius (a length), remapped
 * by transforming the point one radius to the right of the center and measuring the
 * remapped horizontal distance - which recovers the scaled radius under the uniform
 * downscale the remap always inverts (see {@link ./coordinateRemap}).
 */
function remapCoordinates(
  type: (typeof SHAPE_KEYWORDS)[number],
  numbers: number[],
  remap: RemapCoordinate,
): string {
  if (type === "circle") {
    const [cx, cy, r] = numbers;
    const center = remap(cx, cy);
    const edge = remap(cx + r, cy);
    const radius = Math.abs(edge.x - center.x);
    return `${center.x},${center.y},${radius}`;
  }
  const [x1, y1, x2, y2] = numbers;
  const start = remap(x1, y1);
  const end = remap(x2, y2);
  return `${start.x},${start.y},${end.x},${end.y}`;
}

/**
 * Breaks a Shape-Tag-like bracket segment (e.g. `[ Circle : 640 , 360 , 50 : save button
 * : Dotted : Red : Screen 2 ]`) into its parts, tolerating the same sloppy spacing,
 * casing, and separators the canonicalizer repairs. Returns `null` when the segment isn't
 * a shape tag or lacks enough coordinates for its shape (e.g. a rectangle missing corners)
 * - there is nothing to draw. Shared by {@link canonicalizeShapeBracket} (which remaps and
 * re-renders) and the reader {@link ./shapeTagParser} (which packages the parts).
 */
export function parseShapeTagBody(bracketSegment: string): ShapeTagBody | null {
  const inner = bracketSegment.replace(/^\[/, "").replace(/\]$/, "").trim();

  const keywordMatch = inner.match(SHAPE_KEYWORD_PATTERN);
  if (keywordMatch === null) {
    return null;
  }
  const kind = SHAPE_KEYWORD_ALIASES[keywordMatch[1].toLowerCase()];
  const arity = SHAPE_COORDINATE_ARITY[kind];
  const afterKeyword = inner.slice(keywordMatch[0].length);

  // Pull the leading `arity` numbers (comma- or space-separated, floats tolerated) as
  // the coordinates; everything after them is the label/style/screen tail.
  const number = "-?\\d+(?:\\.\\d+)?";
  const coordinatePattern = new RegExp(
    `^\\s*${Array.from({ length: arity }, () => `(${number})`).join("\\s*[\\s,]\\s*")}`,
  );
  const coordinateMatch = afterKeyword.match(coordinatePattern);
  if (coordinateMatch === null) {
    return null;
  }

  const numbers = coordinateMatch
    .slice(1, arity + 1)
    .map((value) => Math.round(Number.parseFloat(value)));
  const { label, style, screenNumber } = classifyTrailingParts(
    afterKeyword.slice(coordinateMatch[0].length),
  );
  return { kind, numbers, label, style, screenNumber };
}

/**
 * Canonicalizes a single Shape-Tag-like bracket segment into the exact form the Overlay
 * parser matches, remapping its coordinates. If the segment has no recoverable coordinate
 * set for its shape it is returned unchanged - there is nothing to repair into a valid tag
 * - exactly as the Point Tag canonicalizer does.
 */
export function canonicalizeShapeBracket(bracketSegment: string, remap: RemapCoordinate): string {
  const body = parseShapeTagBody(bracketSegment);
  if (body === null) {
    return bracketSegment;
  }
  const coordinates = remapCoordinates(body.kind, body.numbers, remap);
  const styleSuffix = renderStyleSuffix(body.style);
  const screenSuffix = body.screenNumber !== null ? `:screen${body.screenNumber}` : "";
  return `[${body.kind.toUpperCase()}:${coordinates}:${body.label}${styleSuffix}${screenSuffix}]`;
}
