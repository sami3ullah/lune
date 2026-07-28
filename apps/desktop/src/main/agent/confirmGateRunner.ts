import {
  classifyConfirmUtterance,
  reconcileGateSignals,
  voteForUtterance,
  type GateVote,
} from "./confirmGateReconciliation";
import { DECLINE_ACKNOWLEDGMENT, REPROMPT_LINE } from "./confirmGateExplanation";

// The shared Confirm Gate coordinator: the one voice-gate flow both the Screen Agent gate
// (`confirmGateController`) and the Task Agent tool gate (`taskAgent/toolConfirmGateController`)
// drive. It owns the untested edge - speaking a plain-language line and arming answer capture -
// and defers every decision to the pure fail-safe reconciliation (`confirmGateReconciliation`),
// so there is exactly one place voice can never approve on an ambiguous reply and one place a
// cancel wins every race. The two callers differ only in *what line they speak* and *what a
// decision means to them*; the flow below is identical, so it lives here once rather than being
// copied per gate (which would force any fix to the fail-safe wiring into two files).

/** One raw answer arriving from a single modality, before it is normalized to a vote. */
export type ConfirmGateAnswerSignal =
  /** An explicit, unambiguous approve/cancel intent (e.g. a future button or hotkey). */
  | { source: "chip" | "hotkey"; intent: "approve" | "cancel" }
  /** A spoken reply; the coordinator classifies the transcript into affirmative/negative/ambiguous. */
  | { source: "voice"; transcript: string };

/** The real edges the coordinator drives; each is injected so the flow stays testable. */
export interface ConfirmGateEdges {
  /** Speaks a line aloud (the explanation, a re-prompt nudge, or the decline ack). Fire-and-forget. */
  speak: (text: string) => void;
  /**
   * Arms answer capture across every modality (chip buttons, the approve/cancel hotkey, and
   * voice), delivering each raw answer to `deliver`. Returns a disposer that tears the
   * capture down (unregisters shortcuts, stops diverting voice to the gate).
   */
  armAnswerCapture: (deliver: (signal: ConfirmGateAnswerSignal) => void) => () => void;
}

/** Normalizes one raw modality answer into a reconciliation vote (classifying voice). */
export function voteForSignal(signal: ConfirmGateAnswerSignal): GateVote {
  if (signal.source === "voice") {
    return voteForUtterance(classifyConfirmUtterance(signal.transcript));
  }
  return signal.intent === "approve" ? "approve" : "cancel";
}

/** One gate to run: the line to speak, the edges to drive, and the run's cancellation signal. */
export interface RunConfirmGateOptions {
  /** The plain-language line spoken to open the gate (each caller builds its own). */
  spokenLine: string;
  /** The injected voice edges (speak + arm answer capture). */
  edges: ConfirmGateEdges;
  /**
   * The run's abort signal - the always-on override. A barge-in ends the wait as
   * not-approved, without a spoken acknowledgment (the session is being cancelled and its
   * fresh recording is already starting, so the gate must not talk over it).
   */
  signal?: AbortSignal;
}

/**
 * Runs one Confirm Gate to a single approve/decline. Speaks the line, then waits: each
 * incoming answer becomes a vote and is reconciled against everything heard so far - a cancel
 * (a negative utterance) stops immediately and is acknowledged aloud, an explicit approve
 * proceeds, and an ambiguous spoken reply re-prompts rather than ever proceeding. Resolves
 * `true` to proceed, `false` to stop (declined or barged-in). See the module comment.
 */
export function runConfirmGate(options: RunConfirmGateOptions): Promise<boolean> {
  const { spokenLine, edges, signal } = options;

  return new Promise<boolean>((resolve) => {
    const votes: GateVote[] = [];
    let settled = false;
    let disposeCapture: () => void = () => {};

    // Single exit: tear down every edge exactly once and resolve. `finish` is a declaration so
    // the abort listener below can reference it before it is reached.
    function finish(approved: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      disposeCapture();
      signal?.removeEventListener("abort", onAbort);
      resolve(approved);
    }

    // A barge-in cancels the whole session: end the wait as not-approved, with no spoken
    // acknowledgment (the new recording is already starting - the gate must not talk over it).
    function onAbort(): void {
      finish(false);
    }

    // Open the gate: speak the plain-language line, then listen for the spoken answer.
    edges.speak(spokenLine);

    disposeCapture = edges.armAnswerCapture((incoming) => {
      if (settled) {
        return;
      }
      votes.push(voteForSignal(incoming));
      const decision = reconcileGateSignals(votes);
      if (decision === "approve") {
        finish(true);
      } else if (decision === "cancel") {
        edges.speak(DECLINE_ACKNOWLEDGMENT);
        finish(false);
      } else if (incoming.source === "voice") {
        // Nothing decisive yet. A fresh ambiguous *spoken* reply re-asks aloud; a chip/hotkey
        // answer never abstains, so this only fires for an unclear utterance.
        edges.speak(REPROMPT_LINE);
      }
    });

    // Honour a signal that was already aborted before the gate even opened, and otherwise
    // arm the barge-in listener. Done after capture is armed so `finish` can dispose it.
    if (signal) {
      if (signal.aborted) {
        finish(false);
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
  });
}
