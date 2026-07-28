import type { ToolConfirmGate, ToolConfirmRequest } from "@lune/core";
import { runConfirmGate, type ConfirmGateEdges } from "../agent/confirmGateRunner";

// The Task Agent's Confirm Gate (M5-02): the voice gate a consequential local tool call passes
// before it runs. It is deliberately the *same* gate as the Screen Agent's - it drives the
// shared `confirmGateRunner`, so the warm spoken line, the voice edges, and crucially the
// fail-safe reconciliation (where "cancel always beats approve" lives) are all reused, not
// re-derived. Only two things are tool-specific: the line it speaks (built from the tool call,
// not an on-screen Action), and the meaning of a decline - here it cancels the single tool
// call (the model is told and adapts), not a whole session.

/** Builds the warm spoken line the gate says before a consequential tool call. */
export function buildToolGateLine(request: ToolConfirmRequest): string {
  return `heads up - i'm about to ${request.summary}. that one's hard to undo. okay to go ahead? yes or no.`;
}

/**
 * Builds the {@link ToolConfirmGate} that backs the local tool set's `confirm` seam, driving
 * the injected {@link ConfirmGateEdges} (the same edges the Screen Agent gate uses) through the
 * shared {@link runConfirmGate}. Resolves `true` to let the consequential call proceed,
 * `false` to cancel it - on a decline, or on a Barge-in / Session-cancel via the request's
 * `signal`.
 */
export function createToolConfirmGateController(edges: ConfirmGateEdges): ToolConfirmGate {
  return (request) =>
    runConfirmGate({ spokenLine: buildToolGateLine(request), edges, signal: request.signal });
}
