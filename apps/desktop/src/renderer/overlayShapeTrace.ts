// The pure geometry behind "the cursor draws the teaching shapes" (Teaching Overlay v2).
// Where overlayCursorFlight flies the cursor along a bezier arc to a point, this samples a
// point along a *shape's outline* so the cursor tip can ride the stroke as it is drawn -
// making a circle/box/polygon/arrow feel hand-drawn rather than blinked on.
//
// The one invariant that makes the cursor tip and the SVG stroke's draw-on stay glued
// together: an outline is a list of polyline *segments* with pen-lifts between them, and
// both `outlineToPathData` (the SVG `d`) and `sampleOutline` (the cursor position) treat an
// inter-segment move as zero painted length. SVG `pathLength` counts a `moveto` (`M`) as
// zero too, so animating a path's `pathLength` from 0 to 1 reveals exactly the same
// fraction of the outline that `sampleOutline(outline, p)` returns - pen-lifts included.
//
// Kept pure (its own tiny point type, no zod/ipc) so the feel is unit-testable exactly like
// overlayCursorFlight; the React component just feeds it a clock and a shape.

/** A point in the Overlay window's local (top-left origin) coordinate space. */
export interface TracePoint {
  x: number;
  y: number;
}

/** One sampled frame of a trace: where the cursor is on the outline, and how it faces. */
export interface TraceSample {
  x: number;
  y: number;
  /**
   * Degrees to rotate the triangle so its tip faces along the outline, using the same
   * +90deg tip convention as {@link ./overlayCursorFlight}'s `flightFrameAt`.
   */
  rotationDegrees: number;
}

/** One polyline run of an outline. A closed segment's last edge returns to its first point. */
export interface OutlineSegment {
  points: TracePoint[];
  closed: boolean;
  /** The painted length of this segment (sum of its edges, closing edge included when closed). */
  length: number;
}

/** A shape's outline as painted-length-annotated segments; moves between segments are unpainted. */
export interface ShapeOutline {
  segments: OutlineSegment[];
  /** The total painted length across every segment (pen-lifts contribute nothing). */
  totalLength: number;
}

/** The shape kinds the tracer can outline - mirrors the Overlay's shape kinds. */
export type TraceableKind = "circle" | "rect" | "highlight" | "arrow" | "line" | "polygon";

/** A shape reduced to what the tracer needs: its kind, defining points, and circle radius. */
export interface TraceableShape {
  kind: TraceableKind;
  points: TracePoint[];
  radius: number | null;
}

/** Knobs for how an outline is built; every one has a sensible default. */
export interface OutlineOptions {
  /** How many segments approximate a circle's ring (more = rounder). */
  circleSegments?: number;
}

const DEFAULT_CIRCLE_SEGMENTS = 64;

/** How long the arrowhead barbs are, in local pixels (shared with the SVG render). */
export const ARROW_HEAD_LENGTH_PX = 14;
/** Half the angle between the two arrowhead barbs. */
export const ARROW_HEAD_SPREAD_RAD = Math.PI / 7;

/**
 * Draw time scales with outline length so a big shape isn't drawn as fast as a tiny one.
 * Deliberately unhurried: the stroke appearing under the cursor is the "hand-drawn" effect
 * itself, and a sub-second trace reads as the mark just blinking on.
 */
const MIN_TRACE_MS = 550;
const MAX_TRACE_MS = 1900;
const TRACE_MS_PER_PIXEL = 1000 / 600;

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(a: TracePoint, b: TracePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The ordered edges of a segment, including the closing edge when it is closed. */
function edgesOf(segment: OutlineSegment): { a: TracePoint; b: TracePoint }[] {
  const edges: { a: TracePoint; b: TracePoint }[] = [];
  for (let i = 0; i + 1 < segment.points.length; i += 1) {
    edges.push({ a: segment.points[i]!, b: segment.points[i + 1]! });
  }
  if (segment.closed && segment.points.length > 1) {
    edges.push({ a: segment.points[segment.points.length - 1]!, b: segment.points[0]! });
  }
  return edges;
}

/** Wraps a set of raw segments (points + closed) into a length-annotated outline. */
function finishOutline(raw: { points: TracePoint[]; closed: boolean }[]): ShapeOutline {
  const segments: OutlineSegment[] = raw
    .filter((segment) => segment.points.length > 0)
    .map((segment) => {
      const withLength: OutlineSegment = { points: segment.points, closed: segment.closed, length: 0 };
      withLength.length = edgesOf(withLength).reduce((sum, edge) => sum + distance(edge.a, edge.b), 0);
      return withLength;
    });
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  return { segments, totalLength };
}

/** The circle's ring as a closed polyline, started at the top and traced clockwise. */
function circleSegments(center: TracePoint, radius: number, count: number): { points: TracePoint[]; closed: boolean }[] {
  const points: TracePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return [{ points, closed: true }];
}

/** The four corners of the axis-aligned box between two opposite points, clockwise from top-left. */
function boxCorners(a: TracePoint, b: TracePoint): TracePoint[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

/** The arrow's shaft plus a two-barb head, as two open segments with a pen-lift between them. */
function arrowSegments(start: TracePoint, end: TracePoint): { points: TracePoint[]; closed: boolean }[] {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const barb = (offset: number): TracePoint => ({
    x: end.x - ARROW_HEAD_LENGTH_PX * Math.cos(angle + offset),
    y: end.y - ARROW_HEAD_LENGTH_PX * Math.sin(angle + offset),
  });
  return [
    { points: [start, end], closed: false },
    { points: [barb(-ARROW_HEAD_SPREAD_RAD), end, barb(ARROW_HEAD_SPREAD_RAD)], closed: false },
  ];
}

/**
 * Builds a shape's outline: the polyline segments the cursor traces. A circle becomes a ring
 * polyline; a rectangle/highlight its closed perimeter; a polygon its closed vertex loop; an
 * arrow a shaft + head; a line its two points. A degenerate shape (too few points) yields an
 * empty outline. This drives the cursor's path; the visible mark is drawn as a primitive
 * (rounded rect, circle, ...) so the corners can be rounded like the reference diagrams.
 */
export function buildOutline(shape: TraceableShape, options: OutlineOptions = {}): ShapeOutline {
  const circleCount = options.circleSegments ?? DEFAULT_CIRCLE_SEGMENTS;

  if (shape.kind === "circle") {
    const center = shape.points[0];
    if (center === undefined || shape.radius === null || shape.radius <= 0) {
      return finishOutline([]);
    }
    return finishOutline(circleSegments(center, shape.radius, circleCount));
  }

  if (shape.kind === "polygon") {
    if (shape.points.length < 3) {
      return finishOutline([]);
    }
    return finishOutline([{ points: shape.points, closed: true }]);
  }

  const [start, end] = shape.points;
  if (start === undefined || end === undefined) {
    return finishOutline([]);
  }

  if (shape.kind === "rect" || shape.kind === "highlight") {
    return finishOutline([{ points: boxCorners(start, end), closed: true }]);
  }

  if (shape.kind === "arrow") {
    return finishOutline(arrowSegments(start, end));
  }

  // line
  return finishOutline([{ points: [start, end], closed: false }]);
}

/**
 * The SVG path `d` for an outline: one `M ... L ...` run per segment (a `Z` closing a closed
 * segment), with a fresh `M` starting each later segment (the zero-length pen-lift). Because
 * `pathLength` and {@link sampleOutline} both treat those moves as unpainted, a `pathLength`
 * draw-on stays glued to the cursor's outline position.
 */
export function outlineToPathData(outline: ShapeOutline): string {
  return outline.segments
    .map((segment) => {
      const [first, ...rest] = segment.points;
      if (first === undefined) {
        return "";
      }
      let data = `M ${first.x} ${first.y}`;
      for (const point of rest) {
        data += ` L ${point.x} ${point.y}`;
      }
      if (segment.closed) {
        data += " Z";
      }
      return data;
    })
    .filter((data) => data.length > 0)
    .join(" ");
}

/**
 * Samples the point on the outline at painted-length fraction `t` in `[0,1]`, with the
 * tangent-facing rotation the cursor should hold there. `t` is clamped; a degenerate
 * zero-length outline returns its first point facing rest (0deg).
 */
export function sampleOutline(outline: ShapeOutline, t: number): TraceSample {
  const firstPoint = outline.segments[0]?.points[0] ?? { x: 0, y: 0 };
  if (outline.totalLength <= 0) {
    return { x: firstPoint.x, y: firstPoint.y, rotationDegrees: 0 };
  }

  // Flatten to painted edges so we can walk by arc length across segment boundaries.
  const edges = outline.segments.flatMap(edgesOf);
  let target = clamp(t, 0, 1) * outline.totalLength;
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]!;
    const length = distance(edge.a, edge.b);
    const isLast = i === edges.length - 1;
    if (target <= length || isLast) {
      const fraction = length > 0 ? clamp(target / length, 0, 1) : 0;
      return {
        x: edge.a.x + (edge.b.x - edge.a.x) * fraction,
        y: edge.a.y + (edge.b.y - edge.a.y) * fraction,
        rotationDegrees: (Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x) * 180) / Math.PI + 90,
      };
    }
    target -= length;
  }
  return { x: firstPoint.x, y: firstPoint.y, rotationDegrees: 0 };
}

/** How long to spend drawing an outline of `totalLength` pixels, clamped to a sane range. */
export function traceDurationMs(totalLength: number): number {
  return clamp(totalLength * TRACE_MS_PER_PIXEL, MIN_TRACE_MS, MAX_TRACE_MS);
}

/**
 * Whether the pen-trace stroke is visible at draw progress `t`. At zero progress an SVG
 * path with round line caps still paints a dot at the outline's start (a zero-length
 * dash gets its caps drawn), and the pen mounts while the cursor is still flying toward
 * the mark - so the stroke stays hidden until the pen has actually touched down. The
 * stroke must never appear at a spot the cursor hasn't reached.
 */
export function penTraceVisibility(t: number): "visible" | "hidden" {
  return t > 0 ? "visible" : "hidden";
}

/** An axis-aligned bounding box in outline coordinates. */
export interface TraceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The axis-aligned bounding box that encloses every one of `shapes`, padded by `padding` on
 * all sides (a circle counts its full radius). Used to place the soft backdrop patch
 * around a teaching step's marks. Returns null when there is nothing to bound.
 */
export function shapesBounds(shapes: TraceableShape[], padding = 0): TraceBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    if (shape.kind === "circle") {
      const center = shape.points[0];
      const radius = shape.radius ?? 0;
      if (center === undefined) {
        continue;
      }
      minX = Math.min(minX, center.x - radius);
      minY = Math.min(minY, center.y - radius);
      maxX = Math.max(maxX, center.x + radius);
      maxY = Math.max(maxY, center.y + radius);
      continue;
    }
    for (const point of shape.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}
