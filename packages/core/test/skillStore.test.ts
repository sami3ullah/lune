import { describe, expect, it } from "vitest";
import { SkillStore, loadSkills, type RawSkillFile } from "../src/skills/skillStore.js";

// The Skill store loads/validates the user's Skills behind an injected directory-read
// seam (the Shell fills it with the userData `skills/` folder; here it's in-memory), and
// holds the live set the conversation reads per turn. It mirrors RoutingConfigStore:
// tolerant load, reload on demand, and an empty set when nothing is there.

function file(id: string, content: string): RawSkillFile {
  return { id, content };
}

describe("loadSkills", () => {
  it("parses every valid file and skips invalid ones (validated on load)", () => {
    const skills = loadSkills(() => [
      file("valid", "do the thing"),
      file("empty", "   "),
      file("also-valid", "---\ntitle: Also\n---\nand this"),
    ]);

    // The empty-instructions file is skipped, not fatal; the two valid ones survive.
    expect(skills.map((skill) => skill.id)).toEqual(["also-valid", "valid"]);
  });

  it("returns skills in a stable id order regardless of directory order", () => {
    const skills = loadSkills(() => [file("charlie", "c"), file("alpha", "a"), file("bravo", "b")]);
    expect(skills.map((skill) => skill.id)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("yields the empty set when the directory has no files", () => {
    expect(loadSkills(() => [])).toEqual([]);
  });
});

describe("SkillStore", () => {
  it("loads on construction and exposes every valid Skill", () => {
    const store = new SkillStore(() => [file("a", "one"), file("b", "two")]);
    expect(store.getSkills().map((skill) => skill.id)).toEqual(["a", "b"]);
  });

  it("returns only enabled Skills as active", () => {
    const store = new SkillStore(() => [
      file("on", "---\nenabled: true\n---\nactive one"),
      file("off", "dormant one"),
    ]);

    expect(store.getActiveSkills().map((skill) => skill.id)).toEqual(["on"]);
    expect(store.getSkills()).toHaveLength(2);
  });

  it("has no active Skills for a fresh install (nothing enabled)", () => {
    const store = new SkillStore(() => [file("a", "one"), file("b", "two")]);
    expect(store.getActiveSkills()).toEqual([]);
  });

  it("adopts the new set on reload when the directory changes", () => {
    let files: RawSkillFile[] = [file("a", "one")];
    const store = new SkillStore(() => files);
    expect(store.getActiveSkills()).toEqual([]);

    // The user (or the tab, M4-02) turns Skill "a" on and adds "b"; a reload re-reads.
    files = [file("a", "---\nenabled: true\n---\none"), file("b", "two")];
    store.reload();

    expect(store.getSkills().map((skill) => skill.id)).toEqual(["a", "b"]);
    expect(store.getActiveSkills().map((skill) => skill.id)).toEqual(["a"]);
  });

  it("hands out copies so a caller can't mutate the store's Skills", () => {
    const store = new SkillStore(() => [file("a", "one")]);
    const skills = store.getSkills();
    skills[0]!.enabled = true;
    // The store's own copy is untouched, so it still reports nothing active.
    expect(store.getActiveSkills()).toEqual([]);
  });
});
