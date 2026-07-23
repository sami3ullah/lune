import type { PointDirective } from "@lune/core";
import type { OverlayEvent } from "../../ipc/overlayControl";
import {
  resolveOverlayPointTarget,
  toWindowLocalPoint,
  type DisplayCaptureGeometry,
} from "./overlayGeometry";

// Plans what the Overlay should do when an answer finishes (ticket 07). Pulling this
// out of the chat handler keeps that handler about chat, and makes the multi-monitor
// pointing sequencing a pure, unit-tested decision rather than inline branching.

/** One Overlay event addressed to a specific display's window. */
export interface OverlayMessage {
  displayId: number;
  event: OverlayEvent;
}

/**
 * Plans the Overlay messages to send once an answer completes, given its pointing
 * directive, the turn's capture geometry, and the display the answer streamed on
 * (the cursor's display). The interaction on the cursor's display always ends here
 * (its response bubble then fades out); pointing is layered on top:
 *
 *   - no point (`none`/`absent`) or an unresolvable target -> just end the cursor
 *     display's interaction.
 *   - point on the cursor's display -> fly its cursor to the target, then end.
 *   - point on another display -> run a brief pointing episode on that display
 *     (start -> point -> end) so the cursor lands on the correct monitor, and end
 *     the cursor display's interaction separately.
 */
export function planCompletionMessages(
  directive: PointDirective,
  geometry: DisplayCaptureGeometry[],
  cursorDisplayId: number,
): OverlayMessage[] {
  const messages: OverlayMessage[] = [];

  if (directive.kind === "point") {
    const target = resolveOverlayPointTarget(directive.point, geometry);
    if (target) {
      const { localX, localY } = toWindowLocalPoint(target);
      const pointEvent: OverlayEvent = {
        type: "point",
        point: { localX, localY, label: directive.point.label },
      };
      if (target.displayId === cursorDisplayId) {
        messages.push({ displayId: cursorDisplayId, event: pointEvent });
      } else {
        messages.push({ displayId: target.displayId, event: { type: "activity-start" } });
        messages.push({ displayId: target.displayId, event: pointEvent });
        messages.push({ displayId: target.displayId, event: { type: "activity-end" } });
      }
    }
  }

  messages.push({ displayId: cursorDisplayId, event: { type: "activity-end" } });
  return messages;
}
