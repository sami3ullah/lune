import {
  buildConfirmGateView,
  DECLINE_ACKNOWLEDGMENT,
  REPROMPT_LINE,
  type ConfirmGateView,
} from "./confirmGateExplanation";
import {
  classifyConfirmUtterance,
  reconcileGateSignals,
  voteForUtterance,
  type GateVote,
} from "./confirmGateReconciliation";
import type { ConfirmGateRequest } from "./screenAgentLoop";

// The Confirm Gate controller (M2-04): the coordinator that sits behind the loop's
// `confirm` seam and turns the three answer modalities - the on-screen chip, the hotkey,
// and voice - into one approve/decline, under the fail-safe reconciliation. The pure parts
// (reconciliation, the plain-language explanation) hold the decisions and the words; this
// owns the wiring (the untested-edge injection): speaking, showing the chip, and arming
// answer capture across the modalities.
//
// The flow of one gate: speak the plain-language explanation and show the chip, then wait.
// Each incoming answer is normalized to a vote (a spoken reply is classified first) and
// reconciled against everything heard so far: a cancel (chip Cancel, Esc, a negative
// utterance) stops immediately, an explicit approve proceeds, and an ambiguous spoken reply
// re-prompts (re-asks aloud) rather than ever proceeding. A decline is acknowledged aloud
// before the session ends.
//
// Answers arrive one at a time (each is its own IPC/hotkey/transcription callback), so the
// first decisive vote settles the gate. The fail-safe "a cancel beats a *simultaneous*
// approve" rule is the reconciliation function's contract, tested there over a set; here,
// serial arrival means whichever decisive answer the user gives first wins. The run's abort
// signal is the always-on override on top of that: a barge-in ends the wait as not-approved
// - without a spoken acknowledgment, since the session is being cancelled and its fresh
// recording is already starting, so the gate must not talk over it - and the loop re-checks
// the same signal before any OS touch, so a barge-in beats even an approve that just resolved.

/** One raw answer arriving from a single modality, before it is normalized to a vote. */
export type ConfirmGateAnswerSignal =
  /** A chip button or the approve/cancel hotkey: an explicit, unambiguous intent. */
  | { source: "chip" | "hotkey"; intent: "approve" | "cancel" }
  /** A spoken reply; the controller classifies the transcript into affirmative/negative/ambiguous. */
  | { source: "voice"; transcript: string };

/** The real edges the controller drives; each is injected so the flow stays testable. */
export interface ConfirmGateEdges {
  /** Speaks a line aloud (the explanation, a re-prompt nudge, or the decline ack). Fire-and-forget. */
  speak: (text: string) => void;
  /** Shows the chip explaining what Lune will do; returns a disposer that hides it. */
  showChip: (view: ConfirmGateView) => () => void;
  /**
   * Arms answer capture across every modality (chip buttons, the approve/cancel hotkey, and
   * voice), delivering each raw answer to `deliver`. Returns a disposer that tears the
   * capture down (unregisters shortcuts, stops diverting voice to the gate).
   */
  armAnswerCapture: (deliver: (signal: ConfirmGateAnswerSignal) => void) => () => void;
}

/** The loop's confirm seam: decide whether the pending Action may run. */
export type ConfirmGate = (request: ConfirmGateRequest) => Promise<boolean>;

/** Normalizes one raw modality answer into a reconciliation vote (classifying voice). */
function voteForSignal(signal: ConfirmGateAnswerSignal): GateVote {
  if (signal.source === "voice") {
    return voteForUtterance(classifyConfirmUtterance(signal.transcript));
  }
  return signal.intent === "approve" ? "approve" : "cancel";
}

/**
 * Builds the Confirm Gate that backs the loop's `confirm` seam, driving the injected
 * {@link ConfirmGateEdges}. See the module comment for the flow; the resolved boolean is
 * `true` to proceed and `false` to stop (declined or barged-in).
 */
export function createConfirmGateController(edges: ConfirmGateEdges): ConfirmGate {
  return function confirm(request: ConfirmGateRequest): Promise<boolean> {
    const view = buildConfirmGateView(request);

    return new Promise<boolean>((resolve) => {
      const votes: GateVote[] = [];
      let settled = false;
      let disposeCapture: () => void = () => {};
      const signal = request.signal;

      // Single exit: tear down every edge exactly once and resolve. `finish` is a
      // declaration so the abort listener below can reference it before it is reached.
      function finish(approved: boolean): void {
        if (settled) {
          return;
        }
        settled = true;
        disposeCapture();
        hideChip();
        signal?.removeEventListener("abort", onAbort);
        resolve(approved);
      }

      // A barge-in cancels the whole session: end the wait as not-approved, with no spoken
      // acknowledgment (the new recording is already starting - the gate must not talk over it).
      function onAbort(): void {
        finish(false);
      }

      // Open the gate: show the chip and speak the explanation, then listen.
      const hideChip = edges.showChip(view);
      edges.speak(view.explanation);

      disposeCapture = edges.armAnswerCapture((incoming) => {
        if (settled) {
          return;
        }
        const vote = voteForSignal(incoming);
        votes.push(vote);
        const decision = reconcileGateSignals(votes);
        if (decision === "approve") {
          finish(true);
        } else if (decision === "cancel") {
          edges.speak(DECLINE_ACKNOWLEDGMENT);
          finish(false);
        } else {
          // Nothing decisive yet. A fresh ambiguous *spoken* reply re-asks aloud; a chip/hotkey
          // answer never abstains, so this only fires for an unclear utterance.
          if (incoming.source === "voice") {
            edges.speak(REPROMPT_LINE);
          }
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
  };
}
