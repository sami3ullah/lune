/**
 * Mark grounding refinement (the drawing-accuracy fix): a vision model reading a whole
 * downscaled screen names the right element but misses its pixels by 2-4% of the image -
 * 25-60 real pixels on a big display. The refinement pass removes that error semantically:
 * after a turn's Shape/Point Tags are parsed, the Shell cuts a native-resolution crop
 * around each mark's guess and asks the model one tiny follow-up - "where exactly is
 * <label> in this image?" - where the element is large, sharp, and unambiguous. The
 * answer's tight box replaces the guess.
 *
 * This module is the Core's half: the request one refinement call sends and the parse of
 * its reply, both pure and Vendor-independent (the request rides the ordinary Reasoning
 * pipeline, so every Vendor gets refinement for free - exactly like the tags themselves).
 * The Shell owns the other half: choosing the crop, cutting the pixels, and applying the
 * refined box back to the mark (`overlay/markRefinement.ts` in the desktop app).
 */
import { parseShapeTagBody } from "./shapeTagCanonicalizer.js";
import type { CoreChatRequest } from "./chatTypes.js";

/** The reply's box in the crop image's pixel space; edges inclusive, corners ordered. */
export interface RefinedMarkBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One refinement call's input: the crop to read and the element to find in it. */
export interface MarkRefinementInput {
  /** Base64-encoded crop bytes (no `data:` prefix). */
  base64Data: string;
  /** The crop's MIME type, e.g. `image/jpeg`. */
  mediaType: string;
  /** The crop's pixel dimensions - the coordinate space the reply must use. */
  widthInPixels: number;
  heightInPixels: number;
  /** The model's own short phrase for the element ("book a demo button"). */
  label: string;
  /**
   * Where the original mark guessed the element sits, in this crop's pixels. Passed to
   * the model as an anchor so that among several plausible matches ("book a demo" the
   * button vs. a demo illustration) it grounds the one the mark was nearest.
   */
  hint?: { x: number; y: number };
}

/**
 * A reply box covering at least this fraction of the crop on both axes is the model
 * marking "everything" - a failed grounding, not an element - and is rejected.
 */
const WHOLE_CROP_REJECT_FRACTION = 0.92;

/** A refined box must be at least this many pixels per axis to be a real element. */
const MIN_BOX_SIZE_PX = 4;

/**
 * The refinement call's own system prompt: a single-purpose grounding instruction that
 * replaces the persona prompt (this call's reply is machine-read, never spoken). The
 * [RECT:...] form is the Shape Tag grammar's, so the pipeline's tag canonicalizer
 * repairs a sloppy reply - and remaps its coordinates - exactly as it does for answers.
 */
const MARK_REFINEMENT_SYSTEM_PROMPT = [
  "you are a precise visual grounding assistant. the user shows you one zoomed-in crop",
  "of a screenshot and names one ui element visible in it. reply with exactly one tag of",
  "the form [RECT:x1,y1,x2,y2] - the tight bounding box of that element in this image's",
  "pixel coordinates. the origin (0,0) is the image's top-left corner, x increases",
  "rightward, y increases downward; (x1,y1) is the element's top-left corner and (x2,y2)",
  "its bottom-right. box the interactive element itself (the whole button, link, field,",
  "or icon), not just its text. reply with the tag alone - no prose, no explanation. if",
  "the named element is not visible in this image, reply exactly [NONE].",
].join(" ");

/**
 * Builds the one-turn chat request of a single mark-refinement call. It deliberately
 * carries no conversation history - the crop plus the element's name is the whole
 * question - and states the crop's dimensions in the exact `<width>x<height> pixels`
 * form the pipeline's downscale rewrite matches, so the stated coordinate space always
 * tracks the image the Vendor actually receives.
 */
export function buildMarkRefinementRequest(input: MarkRefinementInput): CoreChatRequest {
  const hint =
    input.hint === undefined
      ? ""
      : ` a rough earlier estimate placed it near (${input.hint.x}, ${input.hint.y}) in this ` +
        `image; if several elements could match the name, box the one nearest that estimate.`;
  return {
    system: MARK_REFINEMENT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", base64Data: input.base64Data, mediaType: input.mediaType },
          {
            type: "text",
            text:
              `zoomed-in crop of the user's screen (image dimensions: ` +
              `${input.widthInPixels}x${input.heightInPixels} pixels). ` +
              `find this element: "${input.label}".${hint}`,
          },
        ],
      },
    ],
    // Generous relative to the ~20-token reply: a Model Slot in a reasoning mode spends
    // hidden thinking tokens from this same budget, and a too-small cap returns an
    // empty answer (a silently failed refinement) rather than a truncated one.
    maxTokens: 1200,
    // This call's answer is one bounding box read from a sharp zoomed crop - hidden
    // deliberation adds seconds before the drawing can appear and buys no accuracy.
    reasoningEffort: "minimal",
  };
}

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads a refinement reply into the element's box in crop-pixel space, or `null` when
 * the model declined ([NONE]), answered garbage, or marked something implausible - the
 * caller then keeps the mark's original coordinates (the failure mode is always "no
 * worse than before"). Tolerant of prose around the tag and of the sloppy bracket forms
 * the Shape Tag canonicalizer repairs; corners are ordered and clamped to the crop, and
 * a box that spans essentially the whole crop is rejected as a failed grounding.
 */
export function parseMarkRefinementReply(
  reply: string,
  cropWidthInPixels: number,
  cropHeightInPixels: number,
): RefinedMarkBox | null {
  if (cropWidthInPixels <= 0 || cropHeightInPixels <= 0) {
    return null;
  }

  // Try every bracket segment in the reply, first parseable RECT/HIGHLIGHT wins. A model
  // that ignored "no prose" still gets its tag read; one that replied [NONE] (or nothing
  // bracketed) yields null.
  for (const match of reply.matchAll(/\[[^\]]*\]/g)) {
    const body = parseShapeTagBody(match[0]);
    if (body === null || (body.kind !== "rect" && body.kind !== "highlight")) {
      continue;
    }
    const [x1, y1, x2, y2] = body.numbers;
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      continue;
    }
    const left = clamp(Math.min(x1, x2), 0, cropWidthInPixels - 1);
    const right = clamp(Math.max(x1, x2), 0, cropWidthInPixels - 1);
    const top = clamp(Math.min(y1, y2), 0, cropHeightInPixels - 1);
    const bottom = clamp(Math.max(y1, y2), 0, cropHeightInPixels - 1);

    const width = right - left + 1;
    const height = bottom - top + 1;
    if (width < MIN_BOX_SIZE_PX || height < MIN_BOX_SIZE_PX) {
      continue;
    }
    if (
      width >= WHOLE_CROP_REJECT_FRACTION * cropWidthInPixels &&
      height >= WHOLE_CROP_REJECT_FRACTION * cropHeightInPixels
    ) {
      continue;
    }
    return { left, top, right, bottom };
  }

  return null;
}
