/**
 * The Core's notion of a Skill (M4-01): a named, user-editable instruction package
 * that shapes how Lune answers for a class of tasks. A Skill is plain guidance layered
 * onto the persona - not code, and not a tool binding, so it can reference capabilities
 * that don't exist yet (Task Agent tools in M5, MCP in M6) without ever failing.
 *
 * These are the Core's native shapes. Storage (markdown files under userData) and the
 * Skills tab UI (M4-02) are the Shell's concern; the Core owns the model, the on-disk
 * format (`skillDocument`), the load/validate logic (`skillStore`), and how an active
 * Skill enters the Reasoning conversation (`skillInjection`).
 */

/** Where a Skill came from: one the user wrote, or a predefined starter shipped with the app. */
export type SkillSource = "user" | "predefined";

/** One Skill: its identity, the instructions injected when active, and whether it is active. */
export interface Skill {
  /** Stable slug, unique across skills; the storage filename stem. */
  id: string;
  /** Human-readable name shown in the Skills tab (M4-02). */
  title: string;
  /** The markdown instructions injected verbatim - the load-bearing content. */
  instructions: string;
  /**
   * Whether the user has explicitly turned this Skill on. An enabled Skill is injected
   * into every turn until turned off (the explicit-invocation path, M4-01); a disabled
   * one is inert. The flag persists with the Skill, so activation survives restarts.
   */
  enabled: boolean;
  /** Whether this Skill was authored by the user or ships as a predefined starter. */
  source: SkillSource;
}
