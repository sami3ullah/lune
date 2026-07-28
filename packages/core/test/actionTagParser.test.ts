import { describe, expect, it } from "vitest";

import { parseAnswerActionTag } from "../src/reasoning/actionTagParser";

/**
 * Unit tests for the answer routing parser: the Core-owned reader that splits an advisory
 * answer into the spoken text and the optional agent route it carries (M5-04, automatic
 * agent-kind routing). The routing tag is always the final thing in the answer:
 *
 *   [TASK: goal]  scriptable/backgroundable errand -> a background Task Agent (preferred)
 *   [ACT: goal]   un-scriptable on-screen work     -> a foreground Screen Agent (fallback)
 *
 * A plain question carries no tag and stays a pure advisory turn.
 */
describe("parseAnswerActionTag", () => {
  it("routes a trailing task tag to a background Task Agent and strips it", () => {
    const parsed = parseAnswerActionTag(
      "sure, i'll get that going in the background. [TASK: play some lofi on spotify]",
    );
    expect(parsed.displayText).toBe("sure, i'll get that going in the background.");
    expect(parsed.route).toEqual({ kind: "task", goal: "play some lofi on spotify" });
  });

  it("routes a trailing act tag to a foreground Screen Agent and strips it", () => {
    const parsed = parseAnswerActionTag(
      "yep, on it. [ACT: reply to the open email thanking them and send it]",
    );
    expect(parsed.displayText).toBe("yep, on it.");
    expect(parsed.route).toEqual({
      kind: "screen",
      goal: "reply to the open email thanking them and send it",
    });
  });

  it("returns no route for a plain advisory answer", () => {
    const parsed = parseAnswerActionTag("the weather looks clear today.");
    expect(parsed.displayText).toBe("the weather looks clear today.");
    expect(parsed.route).toBeNull();
  });

  it("tolerates spacing and casing in either tag", () => {
    const task = parseAnswerActionTag("on it.  [ task : write me a shopping list note ]  ");
    expect(task.displayText).toBe("on it.");
    expect(task.route).toEqual({ kind: "task", goal: "write me a shopping list note" });

    const screen = parseAnswerActionTag("doing that.  [ Act : close the two youtube tabs ]  ");
    expect(screen.displayText).toBe("doing that.");
    expect(screen.route).toEqual({ kind: "screen", goal: "close the two youtube tabs" });
  });

  it("treats an empty goal as no route so the turn stays advisory", () => {
    const parsed = parseAnswerActionTag("done. [TASK:]");
    expect(parsed.route).toBeNull();
    // The empty tag is still stripped so it is never spoken or shown.
    expect(parsed.displayText).toBe("done.");
  });

  it("only reads a tag anchored to the very end, not a bracket earlier in the prose", () => {
    const parsed = parseAnswerActionTag("the array literal [TASK: not a tag] is just text here.");
    expect(parsed.route).toBeNull();
    expect(parsed.displayText).toBe("the array literal [TASK: not a tag] is just text here.");
  });
});
