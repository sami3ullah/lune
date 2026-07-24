/**
 * The escalate-only Consequence Level floor (DECISIONS #15).
 *
 * An Action's Consequence Level is `max(model tag, hardcoded floor)`: the Reasoning
 * model tags each Action (today `benign`, since the wired Vendors emit no per-Action
 * risk tag), and this fixed Core rule set can only *escalate* the level, never
 * downgrade it. So a model that under-flags a destructive Action cannot slip it past
 * the irreversible Confirm Gate - the floor forces the small class of
 * irreversible-looking Actions to `consequential` regardless.
 *
 * The floor is a *safety floor*, so it deliberately errs toward over-escalation (an
 * extra confirm is cheap; a missed one is not). Its rules, applied to the Action the
 * Core just decided plus the target signal the Shell supplied alongside the screenshot:
 *
 *   - a `click` whose target element's accessibility label/role matches a
 *     consequential keyword (send / delete / pay / submit / buy / ...);
 *   - a `click` on a hyperlink element (navigating to a new URL);
 *   - a `key` press of Return/Enter in a send-like focused context (a search box, a
 *     compose/message field, an address bar).
 *
 * Everything else (type, scroll, copy, observe, and a click on a benign control)
 * stays at the model's tag. The whole thing is pure over its inputs so both the
 * escalation patterns and the never-downgrade property are unit-testable.
 *
 * Carried from v1's Sidecar (`agent/consequenceFloor.ts`), unchanged. v1 shipped this
 * floor with the Shell supplying only the focused element (`elements` empty), so the
 * click-hit-test escalation was inert; wiring the full AX target signal from the Shell
 * is the executor ticket's concern, and this contract is what it fills.
 */
import type { AgentAction, ConsequenceLevel } from "./agentAction.js";
import { escalateConsequence } from "./agentAction.js";

/**
 * One accessibility element the Shell captured for the current screen, with its
 * screen-space frame so the Core can hit-test the Action's coordinate against it.
 * Coordinates are in the Session's active-display space, matching the Action's.
 */
export interface TargetElement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The element's accessibility label / title, if any. */
  label?: string;
  /** The element's accessibility role (e.g. `AXButton`, `AXLink`), if any. */
  role?: string;
}

/**
 * The target signal the Shell supplies alongside the screenshot on each Agent Step
 * so the Core can apply the floor. All fields are optional - an absent signal simply
 * yields no floor escalation.
 */
export interface AgentTargetSignal {
  /** The accessibility label of the currently focused element (context for `key`). */
  focusedLabel?: string;
  /** The accessibility role of the currently focused element. */
  focusedRole?: string;
  /** The interactive elements on screen, for hit-testing a `click`'s coordinate. */
  elements?: TargetElement[];
}

/**
 * Substrings that, appearing in a click target's label or role, mark the Action as
 * consequential. A maintained safety list; over-inclusion is acceptable because an
 * extra confirm is cheap. Matched as case-insensitive substrings, so "Resend" or
 * "Submit order" also escalate.
 */
const CONSEQUENTIAL_LABEL_KEYWORDS: readonly string[] = [
  "send", "delete", "pay", "submit", "buy", "purchase", "checkout", "order",
  "confirm", "publish", "post", "remove", "discard", "trash", "erase",
  "transfer", "withdraw", "unsubscribe", "deactivate", "archive",
];

/**
 * Focused-context substrings that make a Return/Enter press consequential, because
 * in these contexts Return submits or sends. Over-inclusive on purpose.
 */
const SEND_LIKE_CONTEXT_KEYWORDS: readonly string[] = [
  "send", "search", "compose", "message", "reply", "comment", "post", "chat",
  "address", "url", "location", "subject", "recipient", "email",
];

/** Accessibility role fragments identifying a hyperlink (a click navigates away). */
const LINK_ROLE_KEYWORDS: readonly string[] = ["link"];

/** The key combos that submit/confirm in a send-like context (Return / Enter). */
const SUBMIT_KEYS: ReadonlySet<string> = new Set(["return", "enter"]);

/**
 * Applies the escalate-only floor to an Action, returning it with its Consequence
 * Level raised to `max(model tag, floor)`. The Action carries the model tag in its
 * `consequence` field; this resolves the floor and combines the two so the floor can
 * only ever add a confirm, never remove one. The terminal `done` Action carries no
 * consequence and is returned unchanged.
 */
export function applyConsequenceFloor(
  action: AgentAction,
  targetSignal: AgentTargetSignal | undefined,
): AgentAction {
  if (action.kind === "done") {
    return action;
  }
  const floor = resolveConsequenceFloor(action, targetSignal);
  const resolvedConsequence = escalateConsequence(action.consequence, floor);
  // Every non-done member carries `consequence`; overriding it preserves the kind.
  return { ...action, consequence: resolvedConsequence } as AgentAction;
}

/**
 * Resolves the hardcoded floor level for an Action given the target signal, without
 * regard to the model's own tag (the caller combines them with `escalateConsequence`).
 * Returns `consequential` only when a floor rule matches; `benign` otherwise.
 */
export function resolveConsequenceFloor(
  action: AgentAction,
  targetSignal: AgentTargetSignal | undefined,
): ConsequenceLevel {
  if (targetSignal === undefined) {
    return "benign";
  }

  switch (action.kind) {
    case "click": {
      const targetElement = hitTest(targetSignal.elements, action.x, action.y);
      if (targetElement === undefined) {
        return "benign";
      }
      if (
        matchesAny(targetElement.label, CONSEQUENTIAL_LABEL_KEYWORDS) ||
        matchesAny(targetElement.role, CONSEQUENTIAL_LABEL_KEYWORDS) ||
        matchesAny(targetElement.role, LINK_ROLE_KEYWORDS)
      ) {
        return "consequential";
      }
      return "benign";
    }
    case "key": {
      if (isSubmitKey(action.combo) && isSendLikeContext(targetSignal)) {
        return "consequential";
      }
      return "benign";
    }
    case "type": {
      // A compound type that also submits (Gemini's `type_text_at` with press-enter)
      // is the same "Return in a send-like context" risk as a bare submit key.
      if (action.pressEnter === true && isSendLikeContext(targetSignal)) {
        return "consequential";
      }
      return "benign";
    }
    default:
      // scroll, copy, observe: no irreversible OS effect the floor guards.
      return "benign";
  }
}

/**
 * Finds the element whose frame contains the point, preferring the smallest
 * (innermost) match so a click on a specific control is classified by that control,
 * not an enclosing group that happens to be labelled consequential.
 */
function hitTest(
  elements: TargetElement[] | undefined,
  x: number,
  y: number,
): TargetElement | undefined {
  if (elements === undefined) {
    return undefined;
  }
  let smallestContaining: TargetElement | undefined;
  let smallestArea = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    if (!frameContainsPoint(element, x, y)) {
      continue;
    }
    const area = element.width * element.height;
    if (area < smallestArea) {
      smallestArea = area;
      smallestContaining = element;
    }
  }
  return smallestContaining;
}

/** Whether a point falls inside an element's frame (top-left origin, exclusive far edge). */
function frameContainsPoint(element: TargetElement, x: number, y: number): boolean {
  return (
    x >= element.x &&
    x < element.x + element.width &&
    y >= element.y &&
    y < element.y + element.height
  );
}

/** Whether the key combo submits/confirms (its final key is Return or Enter). */
function isSubmitKey(combo: string): boolean {
  const keys = combo.toLowerCase().split("+").map((key) => key.trim());
  return keys.some((key) => SUBMIT_KEYS.has(key));
}

/** Whether the focused context (label or role) reads as a send/submit surface. */
function isSendLikeContext(targetSignal: AgentTargetSignal): boolean {
  return (
    matchesAny(targetSignal.focusedLabel, SEND_LIKE_CONTEXT_KEYWORDS) ||
    matchesAny(targetSignal.focusedRole, SEND_LIKE_CONTEXT_KEYWORDS)
  );
}

/** Case-insensitive substring match of any keyword against the text (absent text never matches). */
function matchesAny(text: string | undefined, keywords: readonly string[]): boolean {
  if (text === undefined) {
    return false;
  }
  const normalizedText = text.toLowerCase();
  return keywords.some((keyword) => normalizedText.includes(keyword));
}
