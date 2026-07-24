/**
 * The canonical Action the Core returns to the Shell on each Agent Step (Screen
 * Agent, DECISIONS #14-15). It is deliberately *vendor-independent*: whichever
 * computer-use Vendor produced the underlying decision (Anthropic's computer-use
 * tool, Gemini's computer-use model), a per-Vendor adapter translates it into one of
 * these shapes, exactly as the SSE adapters translate transport for a chat turn. The
 * Shell executes the Action via synthetic input without knowing which Vendor decided
 * it.
 *
 * Coordinates are in the Agent Session's single active display space (the stated
 * resolution the Vendor reasons about). The Shell remaps them to physical pixels with
 * the same coordinate remap Point Tags already use; the Core does NOT remap them.
 *
 * Carried from v1's Sidecar (`agent/agentAction.ts`), unchanged in shape. Every
 * non-terminal Action carries a `consequence` field resolved through the escalate-only
 * Consequence Level floor before it leaves the Core.
 */

/**
 * Whether an Action needs an explicit confirm before it executes. `benign`
 * Actions run without nagging once the Session is under way; `consequential`
 * Actions (send / delete / pay / submit / overwrite / navigate-away) trip a
 * Confirm Gate. The level is resolved as `max(model tag, hardcoded floor)`
 * (DECISIONS #15) - see `escalateConsequence`.
 */
export type ConsequenceLevel = "benign" | "consequential";

/** The direction a `scroll` Action moves the content. */
export type ScrollDirection = "up" | "down" | "left" | "right";

/** Move the pointer to a display coordinate and click the primary mouse button. */
export interface ClickAction {
  kind: "click";
  /** X coordinate in the Session's active-display space. */
  x: number;
  /** Y coordinate in the Session's active-display space. */
  y: number;
  consequence: ConsequenceLevel;
}

/**
 * Type a Unicode string. In the simplest form (Anthropic's `type`) it types
 * wherever the OS focus currently is. Some Vendors emit a *compound* type (Gemini's
 * `type_text_at`) that also targets a coordinate and optionally submits; the
 * optional fields carry that so the Action stays atomic (one Action per Step)
 * without a second response channel. The Shell, when `x`/`y` are present, clicks
 * that point first; when `pressEnter` is set, it presses Return after typing.
 */
export interface TypeAction {
  kind: "type";
  text: string;
  /** Optional target point to click before typing (active-display space); absent = type at current focus. */
  x?: number;
  /** Optional target point's Y coordinate (paired with `x`). */
  y?: number;
  /** Whether to press Return/Enter after typing (a submit) - the Vendor asked to send. */
  pressEnter?: boolean;
  consequence: ConsequenceLevel;
}

/** Press a key combination, e.g. `"cmd+s"` or `"return"`. */
export interface KeyAction {
  kind: "key";
  /** The key combo exactly as the Vendor expressed it (e.g. `"cmd+s"`, `"return"`). */
  combo: string;
  consequence: ConsequenceLevel;
}

/** Scroll the content at a display coordinate by a Vendor-stated amount. */
export interface ScrollAction {
  kind: "scroll";
  /** X coordinate of the point to scroll at, in active-display space. */
  x: number;
  /** Y coordinate of the point to scroll at, in active-display space. */
  y: number;
  direction: ScrollDirection;
  /** The Vendor's scroll magnitude (its own unit; the Shell maps it to scroll events). */
  amount: number;
  consequence: ConsequenceLevel;
}

/** Write text to the system clipboard - no synthetic event. */
export interface CopyAction {
  kind: "copy";
  text: string;
  consequence: ConsequenceLevel;
}

/**
 * No OS-effecting operation: the Vendor asked only to look at the screen again
 * (Anthropic's computer tool commonly emits a bare `screenshot`/`wait`). The Shell
 * touches nothing, captures a fresh screenshot, and takes the next Step. Modelled
 * as an Action so the loop stays uniform (the Core always returns exactly one Action
 * or `done`) rather than adding a second response channel.
 */
export interface ObserveAction {
  kind: "observe";
  consequence: ConsequenceLevel;
}

/**
 * The terminal Action: the Vendor decided the goal is met. Carries the final spoken
 * text the Shell speaks to tell the user the Agent is done. No further Step follows.
 */
export interface DoneAction {
  kind: "done";
  finalText: string;
}

/** The discriminated set of canonical Actions the Core can return. */
export type AgentAction =
  | ClickAction
  | TypeAction
  | KeyAction
  | ScrollAction
  | CopyAction
  | ObserveAction
  | DoneAction;

/**
 * Resolves an Action's Consequence Level as `max(model tag, hardcoded floor)`
 * (DECISIONS #15). The model tags each Action; a fixed Core rule set can only
 * *escalate* the level, never downgrade it, so a model that under-flags a
 * destructive Action cannot slip it past the Confirm Gate. `consequential`
 * dominates: if either input is `consequential`, the result is `consequential`.
 *
 * The floor *rule set* (matching send/delete/pay labels, new URLs, etc.) lives in
 * `consequenceFloor.ts`; this combinator is the escalate-only contract it plugs into.
 */
export function escalateConsequence(
  modelTag: ConsequenceLevel,
  hardcodedFloor: ConsequenceLevel,
): ConsequenceLevel {
  return modelTag === "consequential" || hardcodedFloor === "consequential"
    ? "consequential"
    : "benign";
}
