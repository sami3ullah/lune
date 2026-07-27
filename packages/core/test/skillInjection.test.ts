import { describe, expect, it } from "vitest";
import {
  ACTIVE_SKILLS_PREAMBLE,
  ACTIVE_SKILLS_SECTION_HEADING,
  renderActiveSkillsSection,
} from "../src/skills/skillInjection.js";
import type { Skill } from "../src/skills/skillTypes.js";

// The active-Skills section (M4-01) is what gets appended to the canonical system prompt
// when Skills are on. It carries the conflict rule (Skills add, base wins) and the
// graceful-degradation contract (a Skill may name a tool that doesn't exist yet).

function skill(id: string, title: string, instructions: string): Skill {
  return { id, title, instructions, enabled: true, source: "user" };
}

describe("renderActiveSkillsSection", () => {
  it("renders nothing when no Skills are active", () => {
    expect(renderActiveSkillsSection([])).toBe("");
  });

  it("opens with the heading and preamble, then the Skill under its title", () => {
    const section = renderActiveSkillsSection([skill("a", "Terse", "keep replies to one line")]);

    expect(section.startsWith(ACTIVE_SKILLS_SECTION_HEADING)).toBe(true);
    expect(section).toContain(ACTIVE_SKILLS_PREAMBLE);
    expect(section).toContain("## Terse");
    expect(section).toContain("keep replies to one line");
  });

  it("states the conflict rule so Skills read as additive, base wins", () => {
    expect(ACTIVE_SKILLS_PREAMBLE).toMatch(/instructions above always win/i);
    expect(ACTIVE_SKILLS_PREAMBLE).toMatch(/add to your instructions/i);
  });

  it("states the graceful-degradation contract for unavailable tools", () => {
    // A Skill may reference a tool that doesn't exist yet (M5/M6); the preamble tells the
    // model to do what it can and say what it can't, never pretend - so injection is safe
    // before those capabilities land.
    expect(ACTIVE_SKILLS_PREAMBLE).toMatch(/don't have yet/i);
    expect(ACTIVE_SKILLS_PREAMBLE).toMatch(/never pretend/i);
  });

  it("renders multiple Skills in the given order, each under its title", () => {
    const section = renderActiveSkillsSection([
      skill("a", "First", "alpha"),
      skill("b", "Second", "bravo"),
    ]);
    expect(section.indexOf("## First")).toBeLessThan(section.indexOf("## Second"));
    expect(section).toContain("alpha");
    expect(section).toContain("bravo");
  });
});
