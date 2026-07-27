import type { ParsedShape } from "@lune/core";
import type { OverlayMessage } from "./overlayPointing";
import type { OverlayShape } from "../../ipc/overlayControl";
import { resolveOverlayShape, type DisplayCaptureGeometry } from "./overlayGeometry";

// Plans what the Overlay draws when a teaching answer completes (M3-02). Pulling this out
// of the chat handler keeps that handler about chat, and makes the multi-monitor shape
// routing a pure, unit-tested decision rather than inline branching - the same shape the
// pointing planner ({@link ./overlayPointing}) takes.
//
// Drawing is independent of the answering/pointing `activity-*` lifecycle: each display
// that has shapes gets a single `draw-shapes` event with its shapes, and nothing else.
// The window shows itself to draw them, they animate on and persist while Lune explains,
// and they are cleared later by a `clear-shapes` broadcast (next turn / Barge-in) or the
// window's own quiet-timeout - so the planner only needs to route the draw.

/**
 * Plans the `draw-shapes` messages for an answer's shapes, one per display that has any.
 * Each shape is resolved onto the monitor the model tagged (unresolvable shapes - no
 * geometry - are dropped), then shapes are grouped by display so each window receives its
 * shapes in one event, preserving the model's order. Returns an empty list when there is
 * nothing to draw.
 */
export function planShapeMessages(
  shapes: ParsedShape[],
  geometry: DisplayCaptureGeometry[],
): OverlayMessage[] {
  // Group resolved shapes by display, keeping insertion order for both the displays and
  // the shapes within each (a Map preserves first-seen key order).
  const shapesByDisplay = new Map<number, OverlayShape[]>();
  for (const shape of shapes) {
    const resolved = resolveOverlayShape(shape, geometry);
    if (resolved === null) {
      continue;
    }
    const existing = shapesByDisplay.get(resolved.displayId);
    if (existing === undefined) {
      shapesByDisplay.set(resolved.displayId, [resolved.shape]);
    } else {
      existing.push(resolved.shape);
    }
  }

  return Array.from(shapesByDisplay, ([displayId, displayShapes]) => ({
    displayId,
    event: { type: "draw-shapes", shapes: displayShapes },
  }));
}
