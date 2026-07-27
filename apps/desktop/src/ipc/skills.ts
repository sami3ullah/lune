import { z } from "zod";

// The Shell's own renderer <-> main IPC for the Skills surface (M4-02). Like Settings and
// the recent-conversations dropdown, these messages never reach the Core over the wire:
// opening the window and reading/writing the Skills files under userData are Shell
// concerns. The Core owns the *model* (the Skill shape, the on-disk markdown format, the
// load/validate store, and how an active Skill injects into the system prompt); this
// contract carries only the tab's browse/create/edit/delete/toggle plumbing. It stays out
// of @lune/shared but is fully zod-typed so nothing untyped crosses the process boundary.
//
// This module is imported by the preload, so it deliberately imports no @lune/core: the
// Skill *source* enum is mirrored here as a tiny local contract (the same way the settings
// contract mirrors the Vendor id enum), keeping the Core the single source of truth for
// the model while leaving the wire codec dependency-free.

/** Renderer -> main (send): open the Skills window, or hide it if already open. */
export const SKILLS_TOGGLE_CHANNEL = "lune:skills:toggle";

/** Renderer -> main (invoke): read every stored Skill (predefined + user) for the tab. */
export const SKILLS_LIST_CHANNEL = "lune:skills:list";

/** Renderer -> main (invoke): create a new user Skill from a title + instructions. */
export const SKILLS_CREATE_CHANNEL = "lune:skills:create";

/** Renderer -> main (invoke): edit a user Skill's title/instructions in place. */
export const SKILLS_UPDATE_CHANNEL = "lune:skills:update";

/** Renderer -> main (invoke): turn a Skill on or off (predefined and user alike). */
export const SKILLS_SET_ENABLED_CHANNEL = "lune:skills:set-enabled";

/** Renderer -> main (invoke): delete a user Skill. */
export const SKILLS_DELETE_CHANNEL = "lune:skills:delete";

/** The renderer-route hash the main process loads the Skills window with. */
export const SKILLS_ROUTE_HASH = "skills";

/**
 * Where a Skill came from: one the user wrote, or a predefined starter shipped with the
 * app. Mirrors the Core's `SkillSource` but is declared locally so this contract (and the
 * preload that imports it) never pulls in @lune/core. The tab uses it to keep the two
 * clearly distinguishable and to gate editing/deleting to the user's own Skills.
 */
export const SkillSourceSchema = z.enum(["user", "predefined"]);
export type SkillSourceValue = z.infer<typeof SkillSourceSchema>;

/**
 * One Skill as the tab renders it: its identity, the instructions that shape answers when
 * it is on, whether it is on, and whether it is a predefined starter or the user's own.
 * Instructions are always non-empty - the store skips a Skill with an empty body on load.
 */
export const SkillSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  enabled: z.boolean(),
  source: SkillSourceSchema,
});
export type SkillValue = z.infer<typeof SkillSchema>;

/** The tab's whole state: every stored Skill. Returned by every mutating call so the UI re-renders from one consistent view. */
export const SkillsSnapshotSchema = z.object({
  skills: z.array(SkillSchema),
});
export type SkillsSnapshotValue = z.infer<typeof SkillsSnapshotSchema>;

/** Renderer -> main payload to create a new user Skill (both fields required, non-empty). */
export const CreateSkillRequestSchema = z.object({
  title: z.string().min(1),
  instructions: z.string().min(1),
});
export type CreateSkillRequest = z.infer<typeof CreateSkillRequestSchema>;

/** Renderer -> main payload to edit a user Skill's title/instructions (its id is stable). */
export const UpdateSkillRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
});
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>;

/** Renderer -> main payload to turn one Skill on or off. */
export const SetSkillEnabledRequestSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});
export type SetSkillEnabledRequest = z.infer<typeof SetSkillEnabledRequestSchema>;

/** Renderer -> main payload to delete one user Skill. */
export const DeleteSkillRequestSchema = z.object({
  id: z.string().min(1),
});
export type DeleteSkillRequest = z.infer<typeof DeleteSkillRequestSchema>;
