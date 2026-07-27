import type { ParsedShape, RefinedMarkBox } from "@lune/core";

// The Shell's half of mark grounding refinement (the drawing-accuracy fix): pure
// geometry for cutting a zoomed crop around a mark's guess and applying the model's
// refined box back to the mark. The Core owns the other half (the refinement request
// and the reply parse, `markGrounding.ts`); the main process glues the two together
// with the actual pixel work (decode native capture -> crop -> JPEG) and the vendor
// call. Keeping this pure - boxes and scales in, boxes out - is what lets the crop
// choice and the coordinate round-trip be unit-tested without Electron or a vendor.
//
// Coordinate spaces: a mark's guess arrives in *captured* pixels (the model-image
// space the canonicalized tags live in, same space the Overlay resolvers consume).
// The crop is planned in *native* pixels (the full-resolution capture the Shell kept
// for this turn), and the refined box comes back in *crop* pixels. `scale` carries
// the captured->native ratio so the round-trip ends where it started: captured space.

/** An axis-aligned box in captured pixels; edges inclusive. */
export interface MarkGuessBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rectangle to cut from the native capture, in native pixels. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A planned refinement crop: where to cut, and the captured->native scale it used. */
export interface PlannedMarkCrop {
  crop: CropRect;
  /** Native pixels per captured pixel (>= 1 when the model image was downscaled). */
  scale: number;
  /**
   * The guess's center in crop-relative pixels - the anchor hint the refinement call
   * passes to the model, so among several plausible matches ("book a demo" the button
   * vs. a demo illustration) it grounds the one the original mark was nearest.
   */
  guessInCrop: { x: number; y: number };
}

/**
 * How far around the guess the crop reaches, as a fraction of the model image's larger
 * dimension (converted to native pixels). This is the "how far off can the model be"
 * budget: vision models miss by 2-4% of the image they read, so 6% of it on every side
 * keeps the true element inside the crop even on a bad guess.
 */
const MODEL_ERROR_PAD_FRACTION = 0.06;

/** The crop also reaches at least this factor of the guess's own larger dimension. */
const GUESS_PAD_FACTOR = 0.75;

/** A crop is never smaller than this per axis (native px): tiny marks still get context. */
const MIN_CROP_SIZE_PX = 320;

/** Breathing room added around a refined element's box (captured px), as drawn marks. */
const REFINED_RECT_MARGIN = 6;
const REFINED_CIRCLE_MARGIN = 8;
/** A refined circle never shrinks below this radius (a legible ring on a tiny icon). */
const REFINED_CIRCLE_MIN_RADIUS = 12;

/** The guess box a Point Tag's single coordinate expands to (a typical control's size). */
const POINT_GUESS_HALF_WIDTH = 30;
const POINT_GUESS_HALF_HEIGHT = 20;

/**
 * A refined box is believed only when its area is within this factor of the guess's
 * (either way). A circle's guess box is its bounding square - up to ~4x the area of a
 * wide, short button it legitimately rings - so the bound is generous; a boxed
 * illustration or content column still lands far outside it.
 */
const MAX_REFINED_AREA_RATIO = 6;

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The guess box (captured px) a shape's coordinates imply, or `null` for a shape
 * refinement doesn't apply to. Only the "focus an element" shapes are refined - a
 * circle and the two box shapes mark one element whose true bounds the refinement
 * recovers. Arrows, lines, and polygons keep the model's points: their endpoints carry
 * meaning (from-here-to-there) a single bounding box can't recover.
 */
export function guessBoxForShape(shape: ParsedShape): MarkGuessBox | null {
  if (shape.kind === "circle") {
    const center = shape.points[0];
    if (center === undefined || shape.radius === null || shape.radius <= 0) {
      return null;
    }
    return {
      left: center.x - shape.radius,
      top: center.y - shape.radius,
      right: center.x + shape.radius,
      bottom: center.y + shape.radius,
    };
  }
  if (shape.kind === "rect" || shape.kind === "highlight") {
    const [a, b] = shape.points;
    if (a === undefined || b === undefined) {
      return null;
    }
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y),
    };
  }
  return null;
}

/** The guess box (captured px) around a Point Tag's single coordinate. */
export function guessBoxForPoint(point: { x: number; y: number }): MarkGuessBox {
  return {
    left: point.x - POINT_GUESS_HALF_WIDTH,
    top: point.y - POINT_GUESS_HALF_HEIGHT,
    right: point.x + POINT_GUESS_HALF_WIDTH,
    bottom: point.y + POINT_GUESS_HALF_HEIGHT,
  };
}

/**
 * Plans the native-pixel crop for one mark: the guess box scaled into native space and
 * padded by the larger of the model's plausible error and the guess's own size, floored
 * at a minimum crop size and clamped inside the native capture (shifting, not shrinking,
 * at an edge - the crop keeps its area so the element stays in frame near a border).
 * Returns `null` when the geometry is degenerate (a zero-size capture).
 */
export function planMarkCrop(
  guess: MarkGuessBox,
  captured: { width: number; height: number },
  native: { width: number; height: number },
): PlannedMarkCrop | null {
  if (captured.width <= 0 || captured.height <= 0 || native.width <= 0 || native.height <= 0) {
    return null;
  }
  const scale = native.width / captured.width;
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const left = guess.left * scale;
  const top = guess.top * scale;
  const right = guess.right * scale;
  const bottom = guess.bottom * scale;
  const guessSize = Math.max(right - left, bottom - top);
  const pad = Math.max(
    GUESS_PAD_FACTOR * guessSize,
    MODEL_ERROR_PAD_FRACTION * Math.max(captured.width, captured.height) * scale,
  );

  let width = Math.round(Math.min(native.width, Math.max(MIN_CROP_SIZE_PX, right - left + 2 * pad)));
  let height = Math.round(Math.min(native.height, Math.max(MIN_CROP_SIZE_PX, bottom - top + 2 * pad)));
  // Center the crop on the guess, then shift it back inside the capture.
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const x = Math.round(clamp(centerX - width / 2, 0, native.width - width));
  const y = Math.round(clamp(centerY - height / 2, 0, native.height - height));
  width = Math.min(width, native.width - x);
  height = Math.min(height, native.height - y);

  return {
    crop: { x, y, width, height },
    scale,
    guessInCrop: {
      x: Math.round(clamp(centerX - x, 0, width - 1)),
      y: Math.round(clamp(centerY - y, 0, height - 1)),
    },
  };
}

/**
 * Whether a refined box is a believable answer for this guess. The model's own size
 * estimate is decent even when its position is off, so a reply whose area is wildly
 * different from the guess's (a demo illustration boxed instead of the demo button)
 * is a misgrounding - the caller keeps the original coordinates. `sizePrior` is false
 * for a Point Tag's synthetic guess box, which states no real size to compare against.
 */
export function refinedBoxIsPlausible(
  guess: MarkGuessBox,
  box: RefinedMarkBox,
  plan: PlannedMarkCrop,
  sizePrior: boolean,
): boolean {
  if (!sizePrior) {
    return true;
  }
  const guessArea = Math.max(1, (guess.right - guess.left) * (guess.bottom - guess.top));
  const boxWidth = (box.right - box.left) / plan.scale;
  const boxHeight = (box.bottom - box.top) / plan.scale;
  const boxArea = Math.max(1, boxWidth * boxHeight);
  const ratio = boxArea / guessArea;
  return ratio >= 1 / MAX_REFINED_AREA_RATIO && ratio <= MAX_REFINED_AREA_RATIO;
}

/** A refined box mapped from crop pixels back to captured pixels (fractional; unclamped). */
function boxToCapturedSpace(
  box: RefinedMarkBox,
  plan: PlannedMarkCrop,
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: (plan.crop.x + box.left) / plan.scale,
    top: (plan.crop.y + box.top) / plan.scale,
    right: (plan.crop.x + box.right) / plan.scale,
    bottom: (plan.crop.y + box.bottom) / plan.scale,
  };
}

/**
 * Applies a refined element box (crop px) back to the mark it refines, returning the
 * shape with its coordinates replaced: a circle re-centers on the element with a radius
 * that just encloses it, a rect/highlight hugs the element's bounds plus breathing room.
 * Kind, label, style, step, and screen are untouched - only where it points changes.
 */
export function applyRefinedBoxToShape(
  shape: ParsedShape,
  box: RefinedMarkBox,
  plan: PlannedMarkCrop,
  captured: { width: number; height: number },
): ParsedShape {
  const element = boxToCapturedSpace(box, plan);

  if (shape.kind === "circle") {
    const radius = Math.max(
      REFINED_CIRCLE_MIN_RADIUS,
      Math.round(Math.max(element.right - element.left, element.bottom - element.top) / 2 + REFINED_CIRCLE_MARGIN),
    );
    return {
      ...shape,
      points: [
        {
          x: Math.round((element.left + element.right) / 2),
          y: Math.round((element.top + element.bottom) / 2),
        },
      ],
      radius,
    };
  }

  return {
    ...shape,
    points: [
      {
        x: Math.round(clamp(element.left - REFINED_RECT_MARGIN, 0, captured.width - 1)),
        y: Math.round(clamp(element.top - REFINED_RECT_MARGIN, 0, captured.height - 1)),
      },
      {
        x: Math.round(clamp(element.right + REFINED_RECT_MARGIN, 0, captured.width - 1)),
        y: Math.round(clamp(element.bottom + REFINED_RECT_MARGIN, 0, captured.height - 1)),
      },
    ],
  };
}

/** The refined element's center in captured pixels - where a Point Tag should land. */
export function refinedPointFromBox(
  box: RefinedMarkBox,
  plan: PlannedMarkCrop,
): { x: number; y: number } {
  const element = boxToCapturedSpace(box, plan);
  return {
    x: Math.round((element.left + element.right) / 2),
    y: Math.round((element.top + element.bottom) / 2),
  };
}
