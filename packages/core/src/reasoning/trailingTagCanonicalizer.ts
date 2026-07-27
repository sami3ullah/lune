/**
 * The trailing-tag family: the shared stream discipline over every directive tag a
 * Reasoning answer appends after its spoken text - the Point Tag ({@link
 * ./pointTagCanonicalizer}) and the teaching-overlay Shape Tags ({@link
 * ./shapeTagCanonicalizer}). Each grammar owns its own bracket repair; this module owns
 * the two things they share:
 *
 *   - {@link TrailingTagStreamGuard} - lets prose flow through promptly (so sentence
 *     streaming keeps first-audio latency low) while holding back the trailing tags
 *     until they are complete, because a tag must be emitted intact, repaired, and
 *     remapped at the very end, and once events are streamed to the Shell they cannot be
 *     unsent. A half-streamed tag must never reach the Shell (it would render partial).
 *
 *   - {@link canonicalizeTrailingTags} - repairs and remaps a whole trailing *run* of
 *     tags (a teaching turn may append several shapes and a point tag), leaving the
 *     prose and any ordinary bracketed text between them untouched.
 *
 * The Overlay parser requires each tag to be emitted intact at the very end of the
 * response, which is why the guard exists. Pure and transport-agnostic; the Electron
 * main process maps the resulting events onto the typed IPC contract.
 */
import type { RemapCoordinate } from "./coordinateRemap.js";
import {
  canonicalizePointBracket,
  couldStartPointTag,
  looksLikePointTag,
} from "./pointTagCanonicalizer.js";
import {
  canonicalizeShapeBracket,
  couldStartShapeTag,
  looksLikeShapeTag,
} from "./shapeTagCanonicalizer.js";

/** True if `bracketSegment` (a complete `[...]`) looks like any trailing directive tag. */
function looksLikeTrailingTag(bracketSegment: string): boolean {
  return looksLikePointTag(bracketSegment) || looksLikeShapeTag(bracketSegment);
}

/**
 * True if `text` (which starts with `[`) could still grow into any trailing tag as more
 * characters stream in. An open bracket that could still become a tag is held back;
 * anything that clearly cannot is flushed.
 */
function couldStartTrailingTag(text: string): boolean {
  return couldStartPointTag(text) || couldStartShapeTag(text);
}

/** Repairs one trailing-tag bracket, dispatching to the grammar it belongs to. */
function canonicalizeTagBracket(bracketSegment: string, remap: RemapCoordinate): string {
  if (looksLikeShapeTag(bracketSegment)) {
    return canonicalizeShapeBracket(bracketSegment, remap);
  }
  return canonicalizePointBracket(bracketSegment, remap);
}

/**
 * Canonicalizes the trailing text of a response: repairs and remaps every trailing tag
 * it contains in place, leaving prose and ordinary bracketed text (e.g. `arr[0]`)
 * untouched. Used to finalize the buffered tail once the whole answer has streamed. A
 * teaching turn may append several shape tags plus a point tag, so this walks the whole
 * run rather than repairing only the first bracket.
 */
export function canonicalizeTrailingTags(trailingText: string, remap: RemapCoordinate): string {
  let result = "";
  let rest = trailingText;

  for (;;) {
    const openIndex = rest.indexOf("[");
    if (openIndex === -1) {
      result += rest;
      break;
    }
    const closeIndex = rest.indexOf("]", openIndex);
    if (closeIndex === -1) {
      // An unclosed bracket: nothing to repair, emit the remainder as-is.
      result += rest;
      break;
    }

    const bracketSegment = rest.slice(openIndex, closeIndex + 1);
    result += rest.slice(0, openIndex);
    result += looksLikeTrailingTag(bracketSegment)
      ? canonicalizeTagBracket(bracketSegment, remap)
      : bracketSegment;
    rest = rest.slice(closeIndex + 1);
  }

  return result;
}

/**
 * A streaming guard that lets response text flow through promptly while holding back
 * the trailing directive tags until they are complete.
 *
 * `push` returns the portion of the accumulated text that is safe to emit now;
 * `finalize` returns the remaining held-back tail with every trailing tag canonicalized
 * and remapped. Once the guard holds back the first trailing tag it holds everything
 * after it too, because the tags are always the last thing in the response.
 */
export class TrailingTagStreamGuard {
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
        // Incomplete bracket. If it could still become a trailing tag, hold it back
        // until it completes (or the stream ends). If it clearly can't, emit it so
        // ordinary unclosed text like "cost is [about" isn't stuck forever - but only
        // once it's long enough to be sure it isn't a trailing-tag prefix.
        if (couldStartTrailingTag(this.buffer)) {
          break;
        }
        emittable += this.buffer;
        this.buffer = "";
        break;
      }

      const bracketSegment = this.buffer.slice(0, closeIndex + 1);
      if (looksLikeTrailingTag(bracketSegment)) {
        // A complete trailing tag: hold it (and anything after) back for finalize,
        // where the whole run is repaired and remapped.
        break;
      }

      // A complete non-tag bracket (e.g. "[0]"): emit it and keep scanning.
      emittable += bracketSegment;
      this.buffer = this.buffer.slice(closeIndex + 1);
    }

    return emittable;
  }

  /** Returns the held-back tail with every trailing tag canonicalized and remapped. */
  finalize(): string {
    const tail = this.buffer;
    this.buffer = "";
    return canonicalizeTrailingTags(tail, this.remap);
  }
}
