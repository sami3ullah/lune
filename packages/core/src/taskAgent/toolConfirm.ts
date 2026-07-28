/**
 * The Task Agent Confirm Gate seam (M5-02): the boundary a consequential local tool call
 * awaits before it runs, analogous to the Screen Agent's Confirm Gate and reusing the same
 * Consequence Level vocabulary (DECISIONS #15).
 *
 * The classifier ({@link import("./toolConsequence.js")}) decides *whether* a call is
 * consequential; this seam is *how* the user is asked. The Core owns neither the words'
 * delivery nor the listening - the Shell injects a gate that speaks a plain-language line
 * and listens for approve/cancel over voice (reusing the M2-04 confirm-gate controller),
 * exactly as the Screen Agent's `confirm` seam is injected. The Core only calls it and
 * honours the boolean.
 *
 * The one invariant the injected gate must uphold - the ticket's "cancel always beats
 * approve" - is a property of the gate's own reconciliation (the Shell's), not of this
 * type: an ambiguous or contradicted answer must resolve `false`, and the run's
 * cancellation `signal` aborting must resolve `false` without waiting. A `false` result
 * cancels the single tool call (the model is told, and can adapt or finish); it does not
 * fail the Session.
 */
import type { ToolConsequence } from "./toolConsequence.js";

/** What the Confirm Gate is being asked to approve - enough for the gate to speak a clear line. */
export interface ToolConfirmRequest {
  /** The tool about to run (e.g. `run_shell_command`). */
  toolName: string;
  /**
   * A short, human summary of the concrete action, for the spoken line - e.g.
   * "run the command: rm -rf ~/Documents" or "overwrite the file notes.md".
   */
  summary: string;
  /** The resolved consequence (always `consequential` when the gate is reached) and its reason. */
  consequence: ToolConsequence;
  /**
   * The Session's cancellation signal. The gate must resolve `false` promptly when this
   * aborts (a Barge-in / dismiss), so a cancel is never blocked waiting on an answer.
   */
  signal?: AbortSignal;
}

/**
 * The Confirm Gate: resolves `true` to let the consequential call proceed, `false` to
 * cancel it. Injected by the Shell; tests pass a fake. See the module comment for the
 * fail-safe invariant the implementation must uphold.
 */
export type ToolConfirmGate = (request: ToolConfirmRequest) => Promise<boolean>;
