/**
 * Reads a finished advisory answer's trailing Act Tag - the signal that the user asked
 * Lune to *do* something on their computer, not merely be told about it (DECISIONS #14:
 * "Lune picks automatically, tools-first, screen-as-fallback"). It is the acting
 * counterpart of {@link ./pointTagParser}: where the Point Tag says "fly the cursor
 * here", the Act Tag says "hand this goal to the Screen Agent and carry it out".
 *
 * The grammar, taught by {@link ./canonicalSystemPrompt} and always the very last thing
 * in the answer (after the spoken text and after any Point Tag):
 *
 *   [ACT: <goal>]   the user wants Lune to perform this on-screen task
 *
 * The model appends it only when the request is an actionable GUI task; a plain question
 * carries no tag and stays a pure advisory turn. `<goal>` is a self-contained imperative
 * (the Screen Agent receives only this goal plus a fresh screenshot, so it must stand on
 * its own without the conversation).
 *
 * Living in the Core keeps the tag grammar owned in one place and Vendor-independent,
 * exactly like the Point Tag: pure and transport-agnostic, so the Electron main process
 * (and any future Shell) reads the same split.
 */

/** An advisory answer split into its spoken text and the optional acting goal it carries. */
export interface ParsedActAnswer {
  /** The answer with the trailing Act Tag removed and trailing whitespace trimmed. */
  displayText: string;
  /**
   * The self-contained goal to hand the Screen Agent, or `null` when the answer carried
   * no Act Tag (a pure advisory turn that touches nothing on screen).
   */
  actGoal: string | null;
}

// Matches a trailing Act Tag (the last thing in the answer, tolerating trailing
// whitespace). Anchored to the end so an earlier bracket in the prose - a code snippet,
// an array literal - is never mistaken for an Act Tag, mirroring the Point Tag parser.
const TRAILING_ACT_TAG = /\[\s*act\s*:\s*([^\]]*)\]\s*$/i;

/**
 * Splits an answer into its spoken display text and its acting goal. The Act Tag, when
 * present, is always the final tag in the answer, so anything before it is the human
 * answer and is returned with trailing whitespace trimmed. A tag with an empty goal is
 * treated as no tag (there is nothing to act on), so the turn stays advisory.
 */
export function parseAnswerActTag(answerText: string): ParsedActAnswer {
  const tagMatch = answerText.match(TRAILING_ACT_TAG);
  if (tagMatch === null) {
    return { displayText: answerText, actGoal: null };
  }

  const goal = tagMatch[1].trim();
  const displayText = answerText.slice(0, tagMatch.index).replace(/\s+$/, "");
  return { displayText, actGoal: goal.length > 0 ? goal : null };
}
