/**
 * Loads the user's Skills from storage and holds the live set the conversation reads
 * on every turn. The successor pattern of `RoutingConfigStore`: the Core owns the
 * load/validate/reload logic behind an injected filesystem seam, and the Electron main
 * process fills that seam with the real directory read (a `skills/` folder under
 * userData) while a test fills it with in-memory files.
 *
 * The seam is deliberately a single `readSkillDirectory()` returning `{ id, content }`
 * per file, so the Core does no directory mechanics (no path joining, no `fs`, no
 * knowledge of the `.md` extension) - that stays in the Shell. Each file is parsed
 * independently and an invalid one (empty instructions) is skipped, so one malformed
 * Skill never breaks the load: the store always yields a usable, well-formed set. This
 * is where "Skills are validated on load" lives.
 *
 * Skills survive restarts because they are files; the store simply re-reads them at
 * startup and on {@link SkillStore.reload}, which the Shell calls when the directory
 * changes (a hand-edit, or the Skills tab writing an edit in M4-02).
 */
import { parseSkillDocument } from "./skillDocument.js";
import type { Skill } from "./skillTypes.js";

/** One raw Skill file the injected seam yields: its id (filename stem) and text content. */
export interface RawSkillFile {
  /** The Skill's stable id, the storage filename stem - unique by construction on a filesystem. */
  id: string;
  /** The file's raw markdown text (frontmatter + instructions). */
  content: string;
}

/**
 * Reads every Skill file from storage. The Shell implements this over the userData
 * `skills/` directory (yielding `[]` when the directory does not exist yet); a test
 * returns an in-memory list. It never throws for "no skills" - an empty array is the
 * empty set.
 */
export type ReadSkillDirectory = () => readonly RawSkillFile[];

/** Parses every raw file into a Skill, skipping invalid ones, sorted by id for a stable order. */
export function loadSkills(readSkillDirectory: ReadSkillDirectory): Skill[] {
  const skills: Skill[] = [];
  for (const file of readSkillDirectory()) {
    const skill = parseSkillDocument(file.id, file.content);
    if (skill !== null) {
      skills.push(skill);
    }
  }
  // A deterministic order (by id) keeps the injected prompt stable across runs, which
  // matters for reproducible behavior and prompt-cache friendliness.
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Holds the live Skill set the conversation reads on every turn, and reloads it from
 * storage on demand. The Shell constructs one at startup and calls {@link reload} when
 * the directory changes, so a Skill toggled or edited takes effect on the next turn
 * with no restart - the successor of {@link RoutingConfigStore}.
 */
export class SkillStore {
  private skills: Skill[];

  constructor(private readonly readSkillDirectory: ReadSkillDirectory) {
    this.skills = loadSkills(readSkillDirectory);
  }

  /** A snapshot of every valid Skill in storage, in stable id order. */
  getSkills(): Skill[] {
    return this.skills.map((skill) => ({ ...skill }));
  }

  /**
   * The Skills the user has turned on - the ones injected into the conversation. Empty
   * when nothing is enabled, so the conversation leaves the system prompt untouched and
   * the Vendor's canonical-prompt fallback wins (no behavior change from a fresh install).
   */
  getActiveSkills(): Skill[] {
    return this.skills.filter((skill) => skill.enabled).map((skill) => ({ ...skill }));
  }

  /** Re-reads the storage directory, adopting the new set (or the empty set if it is gone). */
  reload(): Skill[] {
    this.skills = loadSkills(this.readSkillDirectory);
    return this.getSkills();
  }
}
