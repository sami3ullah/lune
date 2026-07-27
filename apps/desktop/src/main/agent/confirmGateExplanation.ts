import type { AgentAction } from "@lune/core";
import type { ConfirmGateRequest } from "./screenAgentLoop";

// The Confirm Gate's plain-language explanation (M2-04): the words the gate speaks aloud so
// the user knows *what* Lune is about to do before they answer by voice. Pure over the
// request - no speaker or clock - so it is unit-testable and the controller
// (`confirmGateController`) just says what this returns.
//
// The gate never speaks raw coordinates or Vendor jargon: a click is "click on the screen",
// a type is the quoted text it will enter. Only the consequential (hard-to-undo) guard
// remains (DECISIONS #15, revised): it names the Action and warns it may be hard to undo,
// then asks for a plain spoken yes or no. Confirm-to-start was dropped, so there is no
// "start the run" framing here anymore.

/** The longest a quoted `type` string is shown before it is shortened with an ellipsis. */
const MAX_TYPED_PREVIEW = 60;

/** The spoken nudge when a voice reply was too unclear to act on - asks again, never proceeds. */
export const REPROMPT_LINE = "sorry, didn't catch that - yes or no?";

/** The spoken acknowledgment when the user declines a gate; the session then ends cleanly. */
export const DECLINE_ACKNOWLEDGMENT = "no worries, leaving it.";

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
 * Builds the one warm spoken line the gate says before a consequential Action: it names the
 * Action in plain words, flags that it is hard to undo, and asks for a plain yes or no, in
 * Lune's casual voice. The model has already acknowledged the task, so this does not
 * re-narrate the run - it only guards the irreversible step.
 */
export function buildGateSpokenLine(request: ConfirmGateRequest): string {
  return `heads up, i'm about to ${describeGateAction(request.action)} - that one's hard to undo. okay to go ahead? yes or no.`;
}
