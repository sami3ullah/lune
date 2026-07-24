import type { AgentAction } from "@lune/core";
import type { ConfirmGateViewValue } from "../../ipc/confirmGate";
import type { ConfirmGateRequest } from "./screenAgentLoop";

// The Confirm Gate's plain-language explanation (M2-04): the words the gate shows on the
// chip and speaks aloud so the user knows *what* Lune is about to do before they answer.
// Pure over the request - no chip, speaker, or clock - so it is unit-testable and the
// controller (`confirmGateController`) just renders/says what this returns.
//
// The gate never shows raw coordinates or Vendor jargon: a click is "click on the screen",
// a type is the quoted text it will enter. The confirm-to-start gate frames the whole run
// around the user's spoken goal; the irreversible guard names the single consequential
// Action and warns it may be hard to undo, matching the two moments the loop gates
// (DECISIONS #15).

/** The longest a quoted `type` string is shown before it is shortened with an ellipsis. */
const MAX_TYPED_PREVIEW = 60;

/** The one-line "how to answer" tail shared by both gates' explanations and the re-prompt. */
const HOW_TO_ANSWER = 'Say "yes" to go ahead, or "no" to stop.';

/** The spoken nudge when a voice reply was too unclear to act on - asks again, never proceeds. */
export const REPROMPT_LINE = `Sorry, I didn't catch that. ${HOW_TO_ANSWER}`;

/** The spoken acknowledgment when the user declines a gate; the session then ends cleanly. */
export const DECLINE_ACKNOWLEDGMENT = "Okay, I'll stop.";

/** Shortens a typed string to a preview, appending an ellipsis when it was cut. */
function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TYPED_PREVIEW ? `${collapsed.slice(0, MAX_TYPED_PREVIEW)}…` : collapsed;
}

/**
 * A short plain-language phrase for one Action - what Lune will physically do, in words a
 * user understands (never coordinates or Vendor tool names). Used both as the chip's action
 * summary and inside the spoken explanation.
 */
export function describeGateAction(action: AgentAction): string {
  switch (action.kind) {
    case "click":
      return "click on the screen";
    case "type": {
      const typed = `type "${previewText(action.text)}"`;
      return action.pressEnter ? `${typed} and press Enter` : typed;
    }
    case "key":
      return `press "${action.combo}"`;
    case "scroll":
      return `scroll ${action.direction}`;
    case "copy":
      return "copy text to the clipboard";
    case "observe":
      return "take a look at your screen";
    case "done":
      // `done` is terminal and never gated; describe it defensively rather than throw.
      return "finish up";
  }
}

/**
 * What the controller renders on the chip and speaks: the framing, the explanation, the
 * summary. This is exactly the payload sent over the gate IPC, so the type is the one
 * inferred from that zod contract - no parallel shape to drift from it.
 */
export type ConfirmGateView = ConfirmGateViewValue;

/**
 * Builds the {@link ConfirmGateView} for one gate request. Confirm-to-start frames the run
 * around the user's goal and what the first step will be; the irreversible guard names the
 * consequential Action and warns it may be hard to undo. Both end with how to answer.
 */
export function buildConfirmGateView(request: ConfirmGateRequest): ConfirmGateView {
  const actionSummary = describeGateAction(request.action);
  const explanation =
    request.kind === "confirm-to-start"
      ? `I'd like to start working on your screen to ${request.goal}. ` +
        `I'll begin by trying to ${actionSummary}. ${HOW_TO_ANSWER}`
      : `I'm about to ${actionSummary}. This could be hard to undo. ${HOW_TO_ANSWER}`;
  return { kind: request.kind, explanation, actionSummary };
}
