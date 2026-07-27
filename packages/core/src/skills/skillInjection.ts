/**
 * Renders the active Skills into the section that is appended to the Reasoning system
 * prompt (M4-01). This is the one place a Skill's content enters the conversation: the
 * canonical persona + tag grammar leads (owned by `buildConversationRequest`), and this
 * section - the enabled Skills as clearly-delimited additional guidance - follows it.
 *
 * The section encodes the conflict rule and the graceful-degradation contract from the
 * mini-spec, both at the prompt layer where the guidance lives:
 *
 * - Conflict: Skills add task-specific guidance; they never override the persona or the
 *   Point/Shape/Act grammar every Vendor depends on. The preamble says so, so the model
 *   treats them as additive rather than as a replacement prompt.
 * - Degradation: a Skill may reference a tool that doesn't exist yet (M5/M6). The Core
 *   binds a Skill to no tool - it is only text - so nothing can throw, and the preamble
 *   tells the model to do what it can and say what it can't rather than pretend.
 *
 * The Skills are rendered in the order given; the store already sorts them by id, so the
 * section is stable across runs.
 */
import type { Skill } from "./skillTypes.js";

/** The heading that opens the injected Skills section, so it reads as a distinct block. */
export const ACTIVE_SKILLS_SECTION_HEADING = "=== active skills ===";

/**
 * The preamble that frames the Skills for the model. It carries the two rules that make
 * injection safe: Skills are additive (the instructions above win on conflict), and a
 * Skill referencing an unavailable ability degrades gracefully (do what you can, say
 * what you can't - never pretend).
 */
export const ACTIVE_SKILLS_PREAMBLE =
  "the user has turned on the skills below. each one is extra guidance for how to handle " +
  "certain kinds of requests. follow them on top of everything above - they add to your " +
  "instructions, they don't replace them. if a skill ever conflicts with who you are or with " +
  "how you point, draw, and act, the instructions above always win. a skill might mention a " +
  "tool or ability you don't have yet; if it does, do what you can with what you actually have " +
  "and briefly say what you can't do - never pretend to do something you can't.";

/** Renders one Skill as its titled block within the section. */
function renderSkill(skill: Skill): string {
  return `## ${skill.title}\n${skill.instructions.trim()}`;
}

/**
 * Renders the active Skills into the section appended to the system prompt, or the empty
 * string when none are active - which lets the caller (the conversation manager) pass it
 * straight to {@link buildConversationRequest}, whose blank-suffix path leaves the
 * request's system prompt undefined and the Vendor's canonical-prompt fallback in place.
 */
export function renderActiveSkillsSection(activeSkills: readonly Skill[]): string {
  if (activeSkills.length === 0) {
    return "";
  }

  const skillBlocks = activeSkills.map(renderSkill).join("\n\n");
  return `${ACTIVE_SKILLS_SECTION_HEADING}\n${ACTIVE_SKILLS_PREAMBLE}\n\n${skillBlocks}`;
}
