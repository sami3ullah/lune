import { create } from "zustand";
import type { SkillValue } from "../ipc/skills";

// The renderer's view of Skills (M4-02). It mirrors the main process's snapshot - every
// stored Skill (predefined + user) - and exposes the actions the tab calls. Every mutating
// action resolves with the new snapshot and applies it, so the tab always re-renders from
// one consistent view: a Skill toggled on immediately shows as active, a created one
// appears, an edited one updates, a deleted one disappears - no separate refetch.

interface SkillsStoreState {
  /** True once the first snapshot has loaded (before then the surface shows a spinner). */
  loaded: boolean;
  /** Every stored Skill, in the Core's stable id order. */
  skills: SkillValue[];

  /** Loads the full snapshot when the surface opens. */
  load: () => Promise<void>;
  /** Creates a new user Skill; applies the resulting snapshot. */
  create: (title: string, instructions: string) => Promise<void>;
  /** Edits a user Skill's title/instructions; applies the resulting snapshot. */
  update: (id: string, title: string, instructions: string) => Promise<void>;
  /** Turns one Skill on or off; applies the resulting snapshot. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Deletes a user Skill; applies the resulting snapshot. */
  remove: (id: string) => Promise<void>;
}

export const useSkillsStore = create<SkillsStoreState>((set) => ({
  loaded: false,
  skills: [],

  load: async () => {
    const snapshot = await window.lune.skills.list();
    set({ loaded: true, skills: snapshot.skills });
  },
  create: async (title, instructions) => {
    set({ skills: (await window.lune.skills.create({ title, instructions })).skills });
  },
  update: async (id, title, instructions) => {
    set({ skills: (await window.lune.skills.update({ id, title, instructions })).skills });
  },
  setEnabled: async (id, enabled) => {
    set({ skills: (await window.lune.skills.setEnabled({ id, enabled })).skills });
  },
  remove: async (id) => {
    set({ skills: (await window.lune.skills.delete({ id })).skills });
  },
}));
