import { buildGateSpokenLine } from "./confirmGateExplanation";
import {
  runConfirmGate,
  type ConfirmGateEdges,
} from "./confirmGateRunner";
import type { ConfirmGateRequest } from "./screenAgentLoop";

// The Screen Agent's Confirm Gate (M2-04, revised): the coordinator behind the loop's
// `confirm` seam. The voice-gate flow itself now lives in the shared `confirmGateRunner`
// (which the Task Agent tool gate reuses too); this is the thin Screen-Agent adapter over it -
// it turns the pending Action into the warm spoken line (`buildGateSpokenLine`) and hands the
// run's abort signal through, so a consequential, hard-to-undo Action is confirmed by voice
// before it executes. The gate is voice-only (no on-screen modal, DECISIONS #15 revised); an
// ambiguous or unheard reply re-prompts and never proceeds, and a barge-in beats even an
// approve that just resolved.

// Re-exported so existing importers keep a single home for the gate's edge/answer types even
// though the flow moved to `confirmGateRunner`.
export type { ConfirmGateAnswerSignal, ConfirmGateEdges } from "./confirmGateRunner";

/** The loop's confirm seam: decide whether the pending Action may run. */
export type ConfirmGate = (request: ConfirmGateRequest) => Promise<boolean>;

/**
 * Builds the Confirm Gate that backs the loop's `confirm` seam, driving the injected
 * {@link ConfirmGateEdges} through the shared {@link runConfirmGate}. The resolved boolean is
 * `true` to proceed and `false` to stop (declined or barged-in).
 */
export function createConfirmGateController(edges: ConfirmGateEdges): ConfirmGate {
  return (request) =>
    runConfirmGate({ spokenLine: buildGateSpokenLine(request), edges, signal: request.signal });
}
