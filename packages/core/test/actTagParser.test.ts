import { describe, expect, it } from "vitest";

import { parseAnswerActTag } from "../src/reasoning/actTagParser";

/**
 * Unit tests for the answer Act Tag parser: the Core-owned reader that splits an advisory
 * answer into the spoken text and the optional on-screen goal it hands the Screen Agent
 * (DECISIONS #14, advisory->act). The tag is always the final thing in the answer:
 *
 *   [ACT: goal]   the user wants Lune to perform this on-screen task
 */
describe("parseAnswerActTag", () => {
  it("reads a trailing act tag and strips it from the spoken text", () => {
    const parsed = parseAnswerActTag(
      "sure, on it. [ACT: type a short original joke into the discord message box and send it]",
    );
    expect(parsed.displayText).toBe("sure, on it.");
    expect(parsed.actGoal).toBe(
      "type a short original joke into the discord message box and send it",
    );
  });

  it("returns no goal for a plain advisory answer", () => {
    const parsed = parseAnswerActTag("the weather looks clear today.");
    expect(parsed.displayText).toBe("the weather looks clear today.");
    expect(parsed.actGoal).toBeNull();
  });

  it("tolerates spacing and casing in the tag", () => {
    const parsed = parseAnswerActTag("yep, doing that.  [ act : close the two youtube tabs ]  ");
    expect(parsed.displayText).toBe("yep, doing that.");
    expect(parsed.actGoal).toBe("close the two youtube tabs");
  });

  it("treats an empty goal as no tag so the turn stays advisory", () => {
    const parsed = parseAnswerActTag("done. [ACT:]");
    expect(parsed.actGoal).toBeNull();
    // The empty tag is still stripped so it is never spoken or shown.
    expect(parsed.displayText).toBe("done.");
  });

  it("only reads a tag anchored to the very end, not a bracket earlier in the prose", () => {
    const parsed = parseAnswerActTag("the array literal [ACT: not a tag] is just text here.");
    expect(parsed.actGoal).toBeNull();
    expect(parsed.displayText).toBe("the array literal [ACT: not a tag] is just text here.");
  });
});
