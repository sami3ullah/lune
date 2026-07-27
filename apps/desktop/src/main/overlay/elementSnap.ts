import type { ParsedShape } from "@lune/core";

// Element snapping (the drawing-accuracy fix): vision models are semantically right but
// geometrically noisy - they name the correct button yet miss its pixels by 2-4% of the
// image, which is 20-40 real pixels. So a mark's coordinates are treated as a *guess*,
// not the truth: this module looks at the captured screenshot (which the Shell still
// holds in memory) in a neighborhood around the guess, finds the visually-distinct UI
// element there, and moves the mark onto its true bounds. Buttons, fields, icons, and
// menu rows all share the property this exploits: a compact cluster of luminance edges
// (their border and text) surrounded by calmer background.
//
// The pipeline per mark: luminance gradient over a search window around the guess ->
// threshold (adaptive) -> slight dilation so an element's border and text join up ->
// connected components -> score each component's bounding box against the guess ->
// snap to the best one, or keep the model's coordinates when nothing is convincingly
// there (a busy photo background, a blank area, an element bigger than plausible). The
// failure mode is always "no worse than before".
//
// Everything here is pure (typed arrays in, boxes out) so the whole behaviour is
// unit-tested on synthetic screenshots; the main process only decodes the captured JPEG
// into the `SnapImage` this consumes. Coordinates are captured-screenshot pixels - the
// same space the canonicalized tags arrive in - so snapping slots in between the tag
// parser and the display-geometry resolve without touching either.

/** A decoded screenshot reduced to grayscale, in captured-pixel space. */
export interface SnapImage {
  width: number;
  height: number;
  /** Row-major, one byte per pixel (0-255). */
  luminance: Uint8ClampedArray;
}

/** An axis-aligned box in captured pixels; edges inclusive. */
interface PixelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far around the guess to look, as a fraction of the guess's larger dimension. */
const SEARCH_PAD_FRACTION = 0.6;
/** The search pad's floor/ceiling (px): enough to cover typical model error, still local. */
const SEARCH_PAD_MIN = 28;
const SEARCH_PAD_MAX = 96;
/** Breathing room added around a snapped element (the prompt's "few pixels" margin). */
const SNAP_RECT_MARGIN = 6;
const SNAP_CIRCLE_MARGIN = 8;
/** A snapped circle never shrinks below this radius (a legible ring, even on a tiny icon). */
const SNAP_CIRCLE_MIN_RADIUS = 12;
/** The gradient threshold floor: differences quieter than this are background texture. */
const GRADIENT_FLOOR = 18;
/** How far the edge mask is dilated so an element's border and inner text connect. */
const DILATE_RADIUS = 2;
/** Components smaller than this (in edge pixels / box size) are noise, not elements. */
const MIN_COMPONENT_PIXELS = 24;
const MIN_COMPONENT_SIZE_PX = 6;
/**
 * A component's box may be at most this many times the guess's size per axis. The model's
 * size estimate is decent even when its position is off, so an edge cluster vastly bigger
 * than the guess (a page frame, a content column) is not the element it meant.
 */
const MAX_SIZE_RATIO = 4;
/** A component filling nearly the whole search window is background structure, not an element. */
const REGION_FILL_REJECT_FRACTION = 0.92;
/** The minimum overlap (IoU) with the guess for a snap to be accepted without proximity. */
const MIN_ACCEPT_IOU = 0.04;
/** With no overlap, accept only if the centers are within this fraction of the search pad. */
const MAX_CENTER_DISTANCE_PAD_FRACTION = 0.9;
/**
 * With no overlap, a guess that carries a real size estimate (a rect or circle - the
 * model's size is decent even when its position is off) is rescued only onto a component
 * of broadly similar size. This is what keeps a proximity rescue from teleporting a
 * button-shaped mark onto a nearby graphic or icon cluster that merely happens to be the
 * closest edge structure. Similarity is the per-axis size ratio product, in (0, 1].
 */
const MIN_RESCUE_SIZE_SIMILARITY = 0.5;
/**
 * The detected component box is systematically fatter than the element: the central-
 * difference gradient lights up one pixel beyond each edge and the dilation adds
 * {@link DILATE_RADIUS} more, so the true element bounds sit this far inside the box.
 */
const COMPONENT_INFLATION = DILATE_RADIUS + 1;
/**
 * When the winning component touches a border of the search window that could still
 * grow, the element is probably clipped: widen the window and look again, up to this
 * many attempts. A component still touching a growable border on the last attempt is
 * structure that keeps extending past every window we're willing to search - not a
 * discrete element - so the snap is abandoned.
 */
const MAX_DETECTION_ATTEMPTS = 3;
const SEARCH_EXPANSION_FACTOR = 1.8;
/** The search box a Point Tag's single coordinate is expanded to (a typical control's size). */
const POINT_GUESS_HALF_WIDTH = 30;
const POINT_GUESS_HALF_HEIGHT = 20;

/**
 * Reduces a decoded RGBA/BGRA bitmap (4 bytes per pixel, as Electron's
 * `nativeImage.toBitmap()` returns) to the grayscale {@link SnapImage} the snapper
 * consumes. Channel order doesn't matter: the mean of the three color channels is a
 * fine luminance for edge detection either way.
 */
export function luminanceImageFromBitmap(
  bitmap: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): SnapImage {
  const luminance = new Uint8ClampedArray(width * height);
  for (let pixel = 0, byte = 0; pixel < luminance.length; pixel += 1, byte += 4) {
    luminance[pixel] =
      ((bitmap[byte] ?? 0) + (bitmap[byte + 1] ?? 0) + (bitmap[byte + 2] ?? 0)) / 3;
  }
  return { width, height, luminance };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function boxWidth(box: PixelBox): number {
  return box.right - box.left + 1;
}

function boxHeight(box: PixelBox): number {
  return box.bottom - box.top + 1;
}

function boxCenter(box: PixelBox): { x: number; y: number } {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

/** Intersection-over-union of two boxes (0 when they don't overlap). */
function boxIoU(a: PixelBox, b: PixelBox): number {
  const interWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left) + 1;
  const interHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + 1;
  if (interWidth <= 0 || interHeight <= 0) {
    return 0;
  }
  const interArea = interWidth * interHeight;
  const unionArea = boxWidth(a) * boxHeight(a) + boxWidth(b) * boxHeight(b) - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

/** One connected cluster of edge pixels: its bounding box and how many pixels it holds. */
interface EdgeComponent {
  box: PixelBox;
  pixelCount: number;
}

/**
 * The luminance-gradient magnitude over `region`, as a row-major array the size of the
 * region. Central differences, clamped at the image border - cheap and plenty for "is
 * there an edge here".
 */
function regionGradient(image: SnapImage, region: PixelBox): Uint16Array {
  const regionWidth = boxWidth(region);
  const regionHeight = boxHeight(region);
  const gradient = new Uint16Array(regionWidth * regionHeight);
  const { width, height, luminance } = image;
  for (let ry = 0; ry < regionHeight; ry += 1) {
    const y = region.top + ry;
    for (let rx = 0; rx < regionWidth; rx += 1) {
      const x = region.left + rx;
      const leftLum = luminance[y * width + Math.max(0, x - 1)]!;
      const rightLum = luminance[y * width + Math.min(width - 1, x + 1)]!;
      const upLum = luminance[Math.max(0, y - 1) * width + x]!;
      const downLum = luminance[Math.min(height - 1, y + 1) * width + x]!;
      gradient[ry * regionWidth + rx] = Math.abs(rightLum - leftLum) + Math.abs(downLum - upLum);
    }
  }
  return gradient;
}

/**
 * Thresholds the gradient into an edge mask, adaptively: quiet regions keep the floor,
 * busy regions raise the bar so pervasive texture doesn't turn into one giant blob.
 */
function edgeMask(gradient: Uint16Array): Uint8Array {
  let sum = 0;
  for (let i = 0; i < gradient.length; i += 1) {
    sum += gradient[i]!;
  }
  const mean = gradient.length > 0 ? sum / gradient.length : 0;
  let varianceSum = 0;
  for (let i = 0; i < gradient.length; i += 1) {
    const delta = gradient[i]! - mean;
    varianceSum += delta * delta;
  }
  const std = gradient.length > 0 ? Math.sqrt(varianceSum / gradient.length) : 0;
  const threshold = Math.max(GRADIENT_FLOOR, mean + std);

  const mask = new Uint8Array(gradient.length);
  for (let i = 0; i < gradient.length; i += 1) {
    mask[i] = gradient[i]! >= threshold ? 1 : 0;
  }
  return mask;
}

/** Dilates the mask by {@link DILATE_RADIUS} (separable box max) to join border + text. */
function dilateMask(mask: Uint8Array, regionWidth: number, regionHeight: number): Uint8Array {
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < regionHeight; y += 1) {
    for (let x = 0; x < regionWidth; x += 1) {
      let on = 0;
      for (let dx = -DILATE_RADIUS; dx <= DILATE_RADIUS && on === 0; dx += 1) {
        const sx = x + dx;
        if (sx >= 0 && sx < regionWidth && mask[y * regionWidth + sx] === 1) {
          on = 1;
        }
      }
      horizontal[y * regionWidth + x] = on;
    }
  }
  const dilated = new Uint8Array(mask.length);
  for (let y = 0; y < regionHeight; y += 1) {
    for (let x = 0; x < regionWidth; x += 1) {
      let on = 0;
      for (let dy = -DILATE_RADIUS; dy <= DILATE_RADIUS && on === 0; dy += 1) {
        const sy = y + dy;
        if (sy >= 0 && sy < regionHeight && horizontal[sy * regionWidth + x] === 1) {
          on = 1;
        }
      }
      dilated[y * regionWidth + x] = on;
    }
  }
  return dilated;
}

/** Labels the mask's 8-connected components (iterative flood fill; the regions are small). */
function connectedComponents(
  mask: Uint8Array,
  regionWidth: number,
  regionHeight: number,
): EdgeComponent[] {
  const visited = new Uint8Array(mask.length);
  const components: EdgeComponent[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || visited[start] === 1) {
      continue;
    }
    visited[start] = 1;
    stack.length = 0;
    stack.push(start);
    let pixelCount = 0;
    const box: PixelBox = {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    };
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % regionWidth;
      const y = (index - x) / regionWidth;
      pixelCount += 1;
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= regionWidth || ny < 0 || ny >= regionHeight) {
            continue;
          }
          const neighbor = ny * regionWidth + nx;
          if (mask[neighbor] === 1 && visited[neighbor] === 0) {
            visited[neighbor] = 1;
            stack.push(neighbor);
          }
        }
      }
    }
    components.push({ box, pixelCount });
  }
  return components;
}

/**
 * One detection pass over a search window `pad` pixels around the guess: finds the best-
 * scoring plausible component, or `null` when nothing qualifies. Returns the (undeflated)
 * box in image coordinates together with the window, so the caller can tell whether the
 * winner was clipped by the window and needs a wider look.
 */
/**
 * How much size information a guess box carries, deciding how the rescue's similarity
 * gate compares it to a candidate component: a rect/highlight guess states both axes
 * ("box"), a circle's radius states overall scale but not aspect ("scale" compares the
 * larger dimensions only), and a point's synthetic box states nothing ("none").
 */
export type SnapSizePrior = "box" | "scale" | "none";

/** Size similarity of guess vs component under the guess's prior, in (0, 1]. */
function sizeSimilarity(guess: PixelBox, component: PixelBox, prior: SnapSizePrior): number {
  if (prior === "none") {
    return 1;
  }
  if (prior === "scale") {
    const guessMax = Math.max(boxWidth(guess), boxHeight(guess));
    const componentMax = Math.max(boxWidth(component), boxHeight(component));
    return Math.min(guessMax, componentMax) / Math.max(guessMax, componentMax);
  }
  const widthRatio =
    Math.min(boxWidth(guess), boxWidth(component)) / Math.max(boxWidth(guess), boxWidth(component));
  const heightRatio =
    Math.min(boxHeight(guess), boxHeight(component)) /
    Math.max(boxHeight(guess), boxHeight(component));
  return widthRatio * heightRatio;
}

function detectBestComponent(
  guess: PixelBox,
  image: SnapImage,
  pad: number,
  sizePrior: SnapSizePrior,
): { box: PixelBox; region: PixelBox } | null {
  const guessWidth = Math.max(8, boxWidth(guess));
  const guessHeight = Math.max(8, boxHeight(guess));
  const region: PixelBox = {
    left: clamp(Math.round(guess.left) - pad, 0, image.width - 1),
    top: clamp(Math.round(guess.top) - pad, 0, image.height - 1),
    right: clamp(Math.round(guess.right) + pad, 0, image.width - 1),
    bottom: clamp(Math.round(guess.bottom) + pad, 0, image.height - 1),
  };
  const regionWidth = boxWidth(region);
  const regionHeight = boxHeight(region);
  if (regionWidth < MIN_COMPONENT_SIZE_PX || regionHeight < MIN_COMPONENT_SIZE_PX) {
    return null;
  }

  const gradient = regionGradient(image, region);
  const mask = dilateMask(edgeMask(gradient), regionWidth, regionHeight);
  const components = connectedComponents(mask, regionWidth, regionHeight);

  const guessCenter = boxCenter(guess);
  let best: {
    box: PixelBox;
    score: number;
    iou: number;
    centerDistance: number;
    similarity: number;
  } | null = null;
  for (const component of components) {
    const width = boxWidth(component.box);
    const height = boxHeight(component.box);
    // Too small to be a control, or too few edge pixels to be more than speckle.
    if (
      width < MIN_COMPONENT_SIZE_PX ||
      height < MIN_COMPONENT_SIZE_PX ||
      component.pixelCount < MIN_COMPONENT_PIXELS
    ) {
      continue;
    }
    // Fills the search window: background structure (a texture, a frame), not an element.
    if (
      width >= REGION_FILL_REJECT_FRACTION * regionWidth &&
      height >= REGION_FILL_REJECT_FRACTION * regionHeight
    ) {
      continue;
    }
    // Vastly larger than the model's own size estimate: not what it meant to mark.
    if (width > guessWidth * MAX_SIZE_RATIO + 24 || height > guessHeight * MAX_SIZE_RATIO + 24) {
      continue;
    }

    // Back to image coordinates for scoring against the guess.
    const box: PixelBox = {
      left: region.left + component.box.left,
      top: region.top + component.box.top,
      right: region.left + component.box.right,
      bottom: region.top + component.box.bottom,
    };
    const iou = boxIoU(guess, box);
    const center = boxCenter(box);
    const centerDistance = Math.hypot(center.x - guessCenter.x, center.y - guessCenter.y);
    const similarity = sizeSimilarity(guess, box, sizePrior);
    // Overlap dominates; proximity breaks ties and rescues a guess that landed just off
    // the element (the common failure this module exists for); with a real size prior,
    // similar size breaks ties toward the component shaped like what the model marked.
    const score =
      iou +
      Math.max(0, 1 - centerDistance / (pad * 2)) * 0.3 +
      (sizePrior === "none" ? 0 : similarity * 0.2);
    if (best === null || score > best.score) {
      best = { box, score, iou, centerDistance, similarity };
    }
  }

  if (best === null) {
    return null;
  }
  const accepted =
    best.iou >= MIN_ACCEPT_IOU ||
    (best.centerDistance <= pad * MAX_CENTER_DISTANCE_PAD_FRACTION &&
      best.similarity >= MIN_RESCUE_SIZE_SIMILARITY);
  return accepted ? { box: best.box, region } : null;
}

/** Shaves the known dilation/gradient fattening off a component box (never inverting it). */
function deflateComponentBox(box: PixelBox): PixelBox {
  const left = box.left + COMPONENT_INFLATION;
  const top = box.top + COMPONENT_INFLATION;
  const right = box.right - COMPONENT_INFLATION;
  const bottom = box.bottom - COMPONENT_INFLATION;
  if (left > right || top > bottom) {
    return box;
  }
  return { left, top, right, bottom };
}

/**
 * Finds the bounding box (captured pixels) of the UI element nearest `guess`, or `null`
 * when nothing in the neighborhood is convincingly an element - in which case the caller
 * keeps the model's own coordinates. Runs the detection pass over a growing search
 * window: a winner clipped by a window border that could still grow gets a wider look
 * (so a truncated element is never half-snapped), and one that never stops touching is
 * abandoned as background structure. Exported for the point-snap and shape-snap wrappers
 * below (and their tests).
 */
export function elementBoxNear(
  guess: PixelBox,
  image: SnapImage,
  sizePrior: SnapSizePrior = "box",
): PixelBox | null {
  if (image.width <= 0 || image.height <= 0) {
    return null;
  }
  let pad = clamp(
    Math.round(SEARCH_PAD_FRACTION * Math.max(8, Math.max(boxWidth(guess), boxHeight(guess)))),
    SEARCH_PAD_MIN,
    SEARCH_PAD_MAX,
  );

  for (let attempt = 0; attempt < MAX_DETECTION_ATTEMPTS; attempt += 1) {
    const detection = detectBestComponent(guess, image, pad, sizePrior);
    if (detection === null) {
      return null;
    }
    const { box, region } = detection;
    // Touching a window border that is not the image's own edge means the element may
    // extend past what we looked at - the box (and its center) would be skewed.
    const touchesGrowableBorder =
      (box.left === region.left && region.left > 0) ||
      (box.top === region.top && region.top > 0) ||
      (box.right === region.right && region.right < image.width - 1) ||
      (box.bottom === region.bottom && region.bottom < image.height - 1);
    if (!touchesGrowableBorder) {
      return deflateComponentBox(box);
    }
    pad = Math.round(pad * SEARCH_EXPANSION_FACTOR);
  }
  return null;
}

/**
 * Refines one parsed shape's coordinates onto the element it most plausibly marks.
 * Only the "focus an element" shapes are snapped - a circle becomes a ring centered on
 * the element, a rect/highlight hugs its bounds (plus breathing room). Arrows, lines,
 * and polygons keep the model's points: their endpoints carry meaning (from-here-to-
 * there) a bounding box can't recover. Returns the shape unchanged when no element is
 * confidently found.
 */
export function snapShapeToElement(shape: ParsedShape, image: SnapImage): ParsedShape {
  if (shape.kind === "circle") {
    const center = shape.points[0];
    if (center === undefined || shape.radius === null || shape.radius <= 0) {
      return shape;
    }
    const guess: PixelBox = {
      left: center.x - shape.radius,
      top: center.y - shape.radius,
      right: center.x + shape.radius,
      bottom: center.y + shape.radius,
    };
    // A circle's radius states the element's overall scale but not its aspect (a ring
    // around a wide button is much wider than tall), so only scale gates the rescue.
    const element = elementBoxNear(guess, image, "scale");
    if (element === null) {
      return shape;
    }
    const elementCenter = boxCenter(element);
    const radius = Math.max(
      SNAP_CIRCLE_MIN_RADIUS,
      Math.round(Math.max(boxWidth(element), boxHeight(element)) / 2 + SNAP_CIRCLE_MARGIN),
    );
    return {
      ...shape,
      points: [{ x: Math.round(elementCenter.x), y: Math.round(elementCenter.y) }],
      radius,
    };
  }

  if (shape.kind === "rect" || shape.kind === "highlight") {
    const [a, b] = shape.points;
    if (a === undefined || b === undefined) {
      return shape;
    }
    const guess: PixelBox = {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y),
    };
    const element = elementBoxNear(guess, image);
    if (element === null) {
      return shape;
    }
    return {
      ...shape,
      points: [
        {
          x: clamp(element.left - SNAP_RECT_MARGIN, 0, image.width - 1),
          y: clamp(element.top - SNAP_RECT_MARGIN, 0, image.height - 1),
        },
        {
          x: clamp(element.right + SNAP_RECT_MARGIN, 0, image.width - 1),
          y: clamp(element.bottom + SNAP_RECT_MARGIN, 0, image.height - 1),
        },
      ],
    };
  }

  return shape;
}

/**
 * Refines a Point Tag's coordinate onto the center of the element it most plausibly
 * targets (the cursor then lands *on* the button, not beside it), or `null` when no
 * element is confidently found - the caller keeps the model's coordinate.
 */
export function snapPointToElement(
  point: { x: number; y: number },
  image: SnapImage,
): { x: number; y: number } | null {
  const guess: PixelBox = {
    left: point.x - POINT_GUESS_HALF_WIDTH,
    top: point.y - POINT_GUESS_HALF_HEIGHT,
    right: point.x + POINT_GUESS_HALF_WIDTH,
    bottom: point.y + POINT_GUESS_HALF_HEIGHT,
  };
  // A point carries no size estimate - its guess box is synthetic - so the rescue's
  // size-similarity gate would only reject good snaps; proximity alone decides.
  const element = elementBoxNear(guess, image, "none");
  if (element === null) {
    return null;
  }
  const center = boxCenter(element);
  return { x: Math.round(center.x), y: Math.round(center.y) };
}
