import { z } from "zod";

// The Shell's own main -> renderer IPC for the Overlay (ticket 07), kept separate
// from @lune/shared for the same reason as pill-control and screen-permission: these
// messages never reach the Core. Driving a click-through cursor overlay is pure
// OS-and-pixels window plumbing a future HTTP adapter would never carry. They stay
// out of the Core contract but are still fully zod-typed so nothing untyped crosses
// the process boundary (developer story 46).
//
// The Overlay is one full-screen click-through window per display. The main process
// owns the whole interaction and addresses each window individually: it streams the
// answer + a pointing directive to the window on the relevant display, and the window
// just renders what it is told. A window that receives no events stays dormant and
// fully transparent.

/** main -> renderer: every Overlay event for one window rides this one channel. */
export const OVERLAY_EVENT_CHANNEL = "lune:overlay:event";

/**
 * renderer -> main: the Overlay has faded fully out and is idle again. The main
 * process hides the window on this signal, so a full-screen transparent overlay is
 * never left mounted between interactions (nothing to composite, nothing to catch a
 * stray screenshot of a previous turn's cursor).
 */
export const OVERLAY_IDLE_CHANNEL = "lune:overlay:idle";

/**
 * The renderer-route hash the main process loads an Overlay window with. Both the
 * Pill and the Overlay run the same renderer bundle; the entry branches on the hash
 * (matching the Chat Panel's `#chat`). The Pill window carries no hash.
 */
export const OVERLAY_ROUTE_HASH = "overlay";

/**
 * A point the Overlay cursor should fly to, in the window's own display-local
 * coordinate space (the main process converts the global-desktop point into the
 * target window's local space before sending, so the renderer needs no display
 * geometry of its own). The label is the short phrase the model attached to the
 * target ("Save button"), shown as the pointer bubble when there is no answer text.
 */
export const OverlayPointSchema = z.object({
  /** X within this window's display, in logical pixels from the window's top-left. */
  localX: z.number(),
  /** Y within this window's display, in logical pixels from the window's top-left. */
  localY: z.number(),
  label: z.string(),
});
export type OverlayPoint = z.infer<typeof OverlayPointSchema>;

/**
 * One Overlay event, main -> a single window. Two interactions share the surface:
 *
 * Listening (push-to-talk, ticket 11): `listen-start` fades in a live waveform near the
 * cursor while the user holds the hotkey, `listen-level` streams the mic amplitude
 * (0..1) into it, and `listen-end` closes it when the key is released.
 *
 * Answering (ticket 07): `activity-start` fades the cursor in (clearing any previous
 * answer/target), zero or more `answer-delta`s stream the clean answer text into the
 * bubble, an optional `point` flies the cursor to a target, and `activity-end` closes
 * it (after which the window fades out on its inactivity timer). The answer text is
 * already stripped of the Point Tag by the main process, so the bubble only ever shows
 * human-readable text.
 */
export const OverlayEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("listen-start") }),
  z.object({ type: z.literal("listen-level"), level: z.number().min(0).max(1) }),
  z.object({ type: z.literal("listen-end") }),
  z.object({ type: z.literal("activity-start") }),
  z.object({ type: z.literal("answer-delta"), text: z.string() }),
  z.object({ type: z.literal("point"), point: OverlayPointSchema }),
  z.object({ type: z.literal("activity-end") }),
]);
export type OverlayEvent = z.infer<typeof OverlayEventSchema>;
