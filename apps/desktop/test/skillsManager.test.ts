import { describe, expect, it, vi } from "vitest";
import { SkillsManager, type SkillFileStore } from "../src/main/skillsManager";
import type { PredefinedSkill } from "../src/main/predefinedSkills";

// The Skills tab's write path (M4-02). The Core owns the model, the markdown format, and
// the read/inject store; this manager is the Shell side - it seeds the predefined
// starters, mints ids, and persists create/edit/toggle/delete as markdown files, then
// reloads the Core store so a change takes effect on the next turn. Persistence is a
// platform concern, so it sits behind an injected file seam (the same style as
// ConversationHistoryStore) and its logic is exercised here as plain in-memory files.

/** An in-memory Skills directory keyed by id (filename stem), for the injected seam. */
function inMemoryFiles(seed: Record<string, string> = {}): SkillFileStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    list: () => [...map.keys()],
    read: (id) => {
      const content = map.get(id);
      if (content === undefined) {
        throw new Error(`ENOENT: ${id}`);
      }
      return content;
    },
    write: (id, content) => {
      map.set(id, content);
    },
    remove: (id) => {
      map.delete(id);
    },
    has: (id) => map.has(id),
  };
}

const STARTERS: readonly PredefinedSkill[] = [
  { id: "concise", title: "Extra concise", instructions: "answer in one short sentence." },
  { id: "beginner", title: "Beginner friendly", instructions: "define any jargon in plain words." },
];

/** Convenience: the manager's skills as an id->skill map for terse assertions. */
function byId(manager: SkillsManager) {
  return new Map(manager.snapshot().skills.map((skill) => [skill.id, skill]));
}

/** The enabled skills - exactly the set the conversation injects (what shapes answers). */
function activeSkills(manager: SkillsManager) {
  return manager.snapshot().skills.filter((skill) => skill.enabled);
}

describe("SkillsManager - predefined seeding", () => {
  it("seeds every starter into an empty directory, present but turned off", () => {
    const files = inMemoryFiles();
    const manager = new SkillsManager(files, STARTERS);

    const skills = byId(manager);
    expect(skills.get("concise")).toMatchObject({
      title: "Extra concise",
      instructions: "answer in one short sentence.",
      enabled: false,
      source: "predefined",
    });
    expect(skills.get("beginner")?.source).toBe("predefined");
    // A fresh install has nothing active, so the conversation is unchanged until opt-in.
    expect(activeSkills(manager)).toEqual([]);
  });

  it("never overwrites a starter that already exists, so a toggled-on starter survives a restart", () => {
    const files = inMemoryFiles();
    // First run seeds the starters, then the user turns one on.
    new SkillsManager(files, STARTERS).setEnabled("concise", true);

    // A later launch over the same files must not reset the starter back to off.
    const relaunched = new SkillsManager(files, STARTERS);
    expect(byId(relaunched).get("concise")?.enabled).toBe(true);
    expect(activeSkills(relaunched).map((skill) => skill.id)).toEqual(["concise"]);
  });
});

describe("SkillsManager - user skill CRUD", () => {
  it("creates a user skill turned off, so 'create then toggle on' is a real step", () => {
    const manager = new SkillsManager(inMemoryFiles(), STARTERS);

    const snapshot = manager.create("My tone", "be warm and encouraging.");
    const created = snapshot.skills.find((skill) => skill.title === "My tone");
    expect(created).toMatchObject({ source: "user", enabled: false, instructions: "be warm and encouraging." });
    expect(activeSkills(manager)).toEqual([]);
  });

  it("mints a slug id from the title and uniquifies a collision", () => {
    const manager = new SkillsManager(inMemoryFiles(), STARTERS);

    manager.create("Focus Mode", "stay on task.");
    manager.create("Focus mode!", "stay on task, again.");

    const ids = manager.snapshot().skills.map((skill) => skill.id);
    expect(ids).toContain("focus-mode");
    expect(ids).toContain("focus-mode-2");
  });

  it("edits a user skill's title and instructions while preserving its enabled state", () => {
    const manager = new SkillsManager(inMemoryFiles(), STARTERS);
    const created = manager.create("Draft", "first version.").skills.find((skill) => skill.title === "Draft")!;
    manager.setEnabled(created.id, true);

    manager.update(created.id, "Final", "second version.");

    const edited = byId(manager).get(created.id);
    expect(edited).toMatchObject({ title: "Final", instructions: "second version.", enabled: true, source: "user" });
  });

  it("deletes a user skill", () => {
    const manager = new SkillsManager(inMemoryFiles(), STARTERS);
    const created = manager.create("Temp", "throwaway.").skills.find((skill) => skill.title === "Temp")!;

    manager.delete(created.id);

    expect(byId(manager).has(created.id)).toBe(false);
  });
});

describe("SkillsManager - predefined skills are protected but toggleable", () => {
  it("toggles a predefined starter on and off (and it shapes answers only while on)", () => {
    const manager = new SkillsManager(inMemoryFiles(), STARTERS);

    manager.setEnabled("concise", true);
    expect(activeSkills(manager).map((skill) => skill.id)).toEqual(["concise"]);

    manager.setEnabled("concise", false);
    expect(activeSkills(manager)).toEqual([]);
  });

  it("refuses to edit or delete a predefined starter (it stays a stable starting point)", () => {
    const manager = new SkillsManager(inMemoryFiles(), STARTERS);

    manager.update("concise", "Hacked", "overwrite the starter.");
    manager.delete("concise");

    const concise = byId(manager).get("concise");
    expect(concise).toMatchObject({ title: "Extra concise", instructions: "answer in one short sentence." });
  });
});

describe("SkillsManager - reconciling the conversation store", () => {
  it("fires onChanged after seeding and after every persisted mutation, so injection stays live", () => {
    const files = inMemoryFiles();
    const onChanged = vi.fn();
    const manager = new SkillsManager(files, STARTERS, onChanged);

    // Seeding the starters into an empty directory reconciles the live store once.
    expect(onChanged).toHaveBeenCalledTimes(1);

    const created = manager.create("Tone", "be warm.").skills.find((s) => s.title === "Tone")!;
    manager.setEnabled(created.id, true);
    manager.update(created.id, "Tone", "be very warm.");
    manager.delete(created.id);

    // One call per real change (seed + create + toggle + edit + delete).
    expect(onChanged).toHaveBeenCalledTimes(5);
  });

  it("does not fire onChanged on a launch where every starter already exists (nothing to seed)", () => {
    const files = inMemoryFiles();
    new SkillsManager(files, STARTERS); // first run seeds
    const onChanged = vi.fn();
    new SkillsManager(files, STARTERS, onChanged); // second run: starters present
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not fire onChanged for a no-op mutation (toggle to the same state, edit a starter)", () => {
    const files = inMemoryFiles();
    const onChanged = vi.fn();
    const manager = new SkillsManager(files, STARTERS, onChanged);
    onChanged.mockClear(); // ignore the seed call

    manager.setEnabled("concise", false); // already off
    manager.update("concise", "X", "y"); // predefined: not editable
    manager.delete("concise"); // predefined: not deletable
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("SkillsManager - the acceptance flow", () => {
  it("create -> toggle on -> shapes answers -> edit -> delete, all persisted", () => {
    const files = inMemoryFiles();
    const manager = new SkillsManager(files, STARTERS);

    // Create.
    const created = manager.create("Pirate", "talk like a pirate.").skills.find((s) => s.title === "Pirate")!;
    expect(activeSkills(manager)).toEqual([]);

    // Toggle on -> it now shapes every answer (the active set the conversation reads).
    manager.setEnabled(created.id, true);
    expect(activeSkills(manager).map((s) => s.instructions)).toContain("talk like a pirate.");

    // Edit while on.
    manager.update(created.id, "Pirate", "talk like a friendly pirate.");
    expect(activeSkills(manager).map((s) => s.instructions)).toContain("talk like a friendly pirate.");

    // Delete -> gone, and no longer shaping answers.
    manager.delete(created.id);
    expect(activeSkills(manager)).toEqual([]);
    expect(byId(manager).has(created.id)).toBe(false);
  });
});
