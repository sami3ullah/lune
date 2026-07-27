import { describe, expect, it } from "vitest";
import {
  CreateSkillRequestSchema,
  SetSkillEnabledRequestSchema,
  SkillSchema,
  SkillsSnapshotSchema,
  UpdateSkillRequestSchema,
} from "../src/ipc/skills";

// The Skills IPC codec is the Shell's boundary guard for the Skills tab: the main process
// validates the snapshot on the way out and each edit request on the way in, so no untyped
// shape ever writes a Skill file or drives the tab.
describe("Skills IPC codec", () => {
  it("accepts a well-formed Skill and rejects an empty-instructions one", () => {
    const skill = { id: "concise", title: "Extra concise", instructions: "be brief.", enabled: true, source: "predefined" };
    expect(SkillSchema.parse(skill)).toEqual(skill);
    // The store never yields a Skill with an empty body, so the wire codec rejects it too.
    expect(SkillSchema.safeParse({ ...skill, instructions: "" }).success).toBe(false);
    // Only the two known sources are valid.
    expect(SkillSchema.safeParse({ ...skill, source: "system" }).success).toBe(false);
  });

  it("round-trips a snapshot of many skills", () => {
    const snapshot = {
      skills: [
        { id: "a", title: "A", instructions: "x", enabled: false, source: "user" as const },
        { id: "b", title: "B", instructions: "y", enabled: true, source: "predefined" as const },
      ],
    };
    expect(SkillsSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("requires non-empty fields on create/update and a boolean on toggle", () => {
    expect(CreateSkillRequestSchema.safeParse({ title: "T", instructions: "I" }).success).toBe(true);
    expect(CreateSkillRequestSchema.safeParse({ title: "", instructions: "I" }).success).toBe(false);
    expect(CreateSkillRequestSchema.safeParse({ title: "T", instructions: "" }).success).toBe(false);

    expect(UpdateSkillRequestSchema.safeParse({ id: "x", title: "T", instructions: "I" }).success).toBe(true);
    expect(UpdateSkillRequestSchema.safeParse({ id: "", title: "T", instructions: "I" }).success).toBe(false);

    expect(SetSkillEnabledRequestSchema.safeParse({ id: "x", enabled: true }).success).toBe(true);
    expect(SetSkillEnabledRequestSchema.safeParse({ id: "x", enabled: "yes" }).success).toBe(false);
  });
});
