/**
 * The per-Vendor computer-use adapter seam (DECISIONS #14-15).
 *
 * The Screen Agent drives a Shell-stepped loop, but each computer-use Vendor speaks
 * its own native protocol - Anthropic's Messages API with a `computer` tool, Google's
 * `generateContent` with a `computerUse` tool, each with its own conversation shape,
 * coordinate space, and action vocabulary. This interface is the one seam that hides
 * all of that from the Screen Agent Capability: given the session so far and the fresh
 * screenshot, an adapter advances its Vendor's conversation by one Step and returns
 * exactly one *canonical, vendor-independent* `AgentAction` plus the state to persist
 * for the next Step. The Capability stays vendor-agnostic - it resolves the adapter
 * for the routed Vendor, drives `step`, applies the Consequence Level floor, and
 * manages the Session - mirroring how the SSE adapters hide transport for a chat turn.
 *
 * Each adapter owns its own conversation state type; the Capability treats that state
 * as opaque (`unknown`) and hands it straight back next Step, so the two Vendors'
 * very different histories never leak into the Capability.
 *
 * Carried from v1's Sidecar (`agent/computerUseAdapter.ts`); the only change is that
 * the injected boundary is the Core's `UpstreamFetch` (the Reasoning Vendor seam).
 */
import type { AgentAction } from "./agentAction.js";
import type { ComputerUseVendorId } from "./computerUseVendors.js";
import type { UpstreamFetch } from "../reasoning/upstreamFetch.js";

/** A screenshot the Shell captured for one Agent Step (single-screen, full-resolution). */
export interface AgentScreenshot {
  base64Data: string;
  mediaType: string;
}

/** The Session's single active display, in the coordinate space the Vendor reasons about. */
export interface AgentDisplay {
  width: number;
  height: number;
}

/** Everything an adapter needs to advance one Step. */
export interface ComputerUseStepInput {
  /**
   * This adapter's own state from the previous Step, or `undefined` on the first
   * Step of a Session (start a new conversation from `goal`). The Capability stores
   * and returns it verbatim without inspecting it.
   */
  priorState: unknown | undefined;
  /** The user's spoken goal. Present (and required) only on the first Step. */
  goal: string | undefined;
  /** The fresh screenshot for this Step (full-resolution, single-screen). */
  screenshot: AgentScreenshot;
  /** The Session's bound active display - the coordinate space canonical Actions use. */
  display: AgentDisplay;
  /** The model id to drive (the config's Model Slot, or the Vendor default). */
  model: string;
  /** The Vendor's API key (already gated present by the Capability). */
  apiKey: string;
  /** The Vendor boundary (stubbed by the Core-API tests); production is `fetch`. */
  upstreamFetch: UpstreamFetch;
}

/** The result of advancing one Step. */
export interface ComputerUseStepResult {
  /** The single canonical Action to return to the Shell (may be terminal `done`). */
  action: AgentAction;
  /**
   * The adapter state to persist for the next Step, or `undefined` when the Session
   * is terminal (the Action is `done`) and should be dropped.
   */
  nextState: unknown | undefined;
}

/** One computer-use Vendor's adapter: advance its native conversation by one Step. */
export interface ComputerUseVendorAdapter {
  /** Which Vendor this adapter drives; matches the routing config's Vendor. */
  readonly vendorId: ComputerUseVendorId;
  /**
   * Advance the Session one Step: build and issue the Vendor request (through the
   * injected `upstreamFetch`), then translate the response into a canonical Action
   * plus the state to persist. Throws on an upstream failure so the Capability can
   * stop the Session cleanly with an error.
   */
  step(input: ComputerUseStepInput): Promise<ComputerUseStepResult>;
}

/**
 * Throws a descriptive error when a Vendor's step response is not OK, so each
 * adapter's `step` can fail identically and the Capability stops the Session cleanly.
 * Includes the Vendor's own error body, which carries the actual reason (bad model
 * id, auth, rate limit) a bare status code would hide.
 */
export async function throwIfStepResponseNotOk(
  response: Response,
  vendorDisplayName: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const errorBody = await response.text().catch(() => "");
  throw new Error(
    `${vendorDisplayName} agent step failed: HTTP ${response.status}${errorBody ? ` - ${errorBody}` : ""}`,
  );
}
