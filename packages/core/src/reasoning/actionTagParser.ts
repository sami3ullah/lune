/**
 * Reads a finished advisory answer's trailing routing tag - the signal that the user asked
 * Lune to *do* something on their computer, and which kind of agent should carry it out
 * (M5-04, automatic agent-kind routing, tools-first). It is the acting counterpart of
 * {@link ./pointTagParser}: where the Point Tag says "fly the cursor here", a routing tag
 * says "hand this goal to an agent and carry it out".
 *
 * The Reasoning model picks the route itself, guided by {@link ./canonicalSystemPrompt}
 * (DECISIONS #14: "Lune picks automatically, tools-first, screen-as-fallback"). There are
 * two, always the very last thing in the answer (after the spoken text and after any Point
 * or Shape Tag):
 *
 *   [TASK: <goal>]  a scriptable, backgroundable errand -> a background Task Agent (preferred)
 *   [ACT:  <goal>]  un-scriptable on-screen GUI work     -> a foreground Screen Agent (fallback)
 *
 * The model appends exactly one, and only when the turn is actionable; a plain question
 * carries no tag and stays a pure advisory turn. `<goal>` is a self-contained imperative
 * (the agent receives only this goal - a fresh screenshot for the Screen Agent, nothing
 * but tools for the Task Agent - so it must stand on its own without the conversation).
 *
 * Living in the Core keeps the tag grammar owned in one place and Vendor-independent,
 * exactly like the Point Tag: pure and transport-agnostic, so the Electron main process
 * (and any future Shell) reads the same split and routes the same way.
 */

/**
 * Which agent an answer's routing tag hands its goal to. `task` is a background,
 * tools-only Task Agent (the preferred, tools-first path); `screen` is the foreground
 * Screen Agent (the fallback for GUI work no tool can script). Both carry the same kind of
 * self-contained goal - only the executor differs.
 */
export type AgentRoute =
  | { kind: "task"; goal: string }
  | { kind: "screen"; goal: string };

/** An advisory answer split into its spoken text and the optional agent route it carries. */
export interface ParsedActionAnswer {
  /** The answer with the trailing routing tag removed and trailing whitespace trimmed. */
  displayText: string;
  /**
   * The agent to hand the goal to, or `null` when the answer carried no routing tag (a
   * pure advisory turn that touches nothing on the user's computer).
   */
  route: AgentRoute | null;
}

// Matches a trailing routing tag (the last thing in the answer, tolerating trailing
// whitespace): the keyword (`task` or `act`) then its goal. Anchored to the end so an
// earlier bracket in the prose - a code snippet, an array literal - is never mistaken for a
// routing tag, mirroring the Point Tag parser.
const TRAILING_ROUTING_TAG = /\[\s*(task|act)\s*:\s*([^\]]*)\]\s*$/i;

/**
 * Splits an answer into its spoken display text and the agent route it carries. The routing
 * tag, when present, is always the final tag in the answer, so anything before it is the
 * human answer and is returned with trailing whitespace trimmed. A tag with an empty goal is
 * treated as no tag (there is nothing to act on), so the turn stays advisory. The keyword
 * selects the route: `task` -> a background Task Agent, `act` -> the foreground Screen Agent.
 */
export function parseAnswerActionTag(answerText: string): ParsedActionAnswer {
  const tagMatch = answerText.match(TRAILING_ROUTING_TAG);
  if (tagMatch === null) {
    return { displayText: answerText, route: null };
  }

  const goal = tagMatch[2].trim();
  const displayText = answerText.slice(0, tagMatch.index).replace(/\s+$/, "");
  if (goal.length === 0) {
    // An empty goal has nothing to act on: strip the stray tag but keep the turn advisory.
    return { displayText, route: null };
  }

  const kind = tagMatch[1].toLowerCase() === "task" ? "task" : "screen";
  return { displayText, route: { kind, goal } };
}
