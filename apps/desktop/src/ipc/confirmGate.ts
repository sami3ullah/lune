import { z } from "zod";

// The Shell's own main <-> renderer IPC for the Screen Agent Confirm Gate (M2-04), kept
// separate from @lune/shared like pill-control / overlay-control: these messages never
// reach the Core (the gate UX is pure Shell). The gate is a small focusable window - unlike
// the click-through Overlay, it must catch clicks so the user can answer with a button - so
// it is its own surface addressed on its own channels, still fully zod-typed so nothing
// untyped crosses the process boundary.

/** main -> renderer: open the gate with an explanation, or close it once answered. */
export const CONFIRM_GATE_EVENT_CHANNEL = "lune:confirm-gate:event";

/** renderer -> main: the user pressed the chip's Approve or Cancel button. */
export const CONFIRM_GATE_ANSWER_CHANNEL = "lune:confirm-gate:answer";

/**
 * The renderer-route hash the main process loads the gate window with, branched on in the
 * renderer entry exactly like `#chat` / `#overlay`.
 */
export const CONFIRM_GATE_ROUTE_HASH = "gate";

/** Whether the gate is the confirm-to-start gate or the mid-session irreversible guard. */
export const ConfirmGateKindSchema = z.enum(["confirm-to-start", "irreversible"]);

/** What the chip renders: the plain-language explanation and a short action headline. */
export const ConfirmGateViewSchema = z.object({
  kind: ConfirmGateKindSchema,
  /** The full plain-language explanation of what Lune is about to do (also spoken aloud). */
  explanation: z.string(),
  /** A short phrase naming the pending Action, for the chip's headline. */
  actionSummary: z.string(),
});
export type ConfirmGateViewValue = z.infer<typeof ConfirmGateViewSchema>;

/** One gate event, main -> the gate window: open (with its view) or close. */
export const ConfirmGateEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), view: ConfirmGateViewSchema }),
  z.object({ type: z.literal("close") }),
]);
export type ConfirmGateEvent = z.infer<typeof ConfirmGateEventSchema>;

/** The chip's answer, renderer -> main: approve proceeds, cancel stops the session. */
export const ConfirmGateAnswerSchema = z.object({
  intent: z.enum(["approve", "cancel"]),
});
export type ConfirmGateAnswerValue = z.infer<typeof ConfirmGateAnswerSchema>;
