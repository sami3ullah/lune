import { loadSkills, serializeSkillDocument, type RawSkillFile, type Skill } from "@lune/core";
import type { PredefinedSkill } from "./predefinedSkills";

// The Shell's write half of Skills (M4-02). The Core owns the model, the on-disk markdown
// format (`serializeSkillDocument`/`parseSkillDocument`), and the load/validate logic
// (`loadSkills`); the main process owns the live conversation-facing `SkillStore` and how
// an active Skill injects into the system prompt (M4-01). This manager owns everything the
// Skills tab needs to *change* that set: seeding the predefined starters, minting ids, and
// persisting create/edit/toggle/delete as markdown files.
//
// It deliberately does NOT hold its own SkillStore. There is one store - the one the
// conversation reads each turn - so after every write the manager fires an injected
// `onChanged` callback (wired to that store's `reload`) rather than reloading a private
// copy that could drift from what actually shapes answers. Its own reads go through the
// Core's pure `loadSkills`, so the tab always renders the exact set on disk.
//
// Persistence is a platform concern, so - like ConversationHistoryStore - it sits behind
// an injected file seam that works purely in ids (filename stems) and raw content. All
// path/`fs`/`.md` mechanics stay in the main process's real implementation; the manager
// (and its tests) never touch the disk, keeping this logic a plain unit under test.

/**
 * The Skills directory as a keyed set of markdown documents. Deliberately id-based (never
 * paths): the real implementation in the main process joins the userData `skills/` dir and
 * appends `.md`, a test backs it with an in-memory map. `read` throws for a missing id
 * (mirroring `fs`), so callers check `has` first.
 */
export interface SkillFileStore {
  /** The ids (filename stems) of every Skill document present. */
  list(): string[];
  /** The raw markdown of one Skill document; throws if the id is absent. */
  read(id: string): string;
  /** Writes (creating or replacing) one Skill document. */
  write(id: string, content: string): void;
  /** Removes one Skill document; a no-op if it is already absent. */
  remove(id: string): void;
  /** Whether a Skill document exists for this id. */
  has(id: string): boolean;
}

/** The tab's whole state: every stored Skill (predefined + user), in the Core's stable order. */
export interface SkillsSnapshot {
  skills: Skill[];
}

/**
 * Turns a title into a filesystem-safe slug used as the Skill's stable id (its filename
 * stem). Lowercased, non-alphanumerics collapsed to single dashes, trimmed; an all-symbol
 * title falls back to "skill" so there is always a usable stem.
 */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "skill";
}

export class SkillsManager {
  /**
   * @param files    The injected Skills-directory seam (real fs in the main process, in-memory in tests).
   * @param predefined The curated starters to seed on first run.
   * @param onChanged Fired after any persisted change so the conversation's SkillStore reloads
   *                   and the very next turn injects the new set. Defaults to a no-op for tests
   *                   that only assert on the files.
   */
  constructor(
    private readonly files: SkillFileStore,
    private readonly predefined: readonly PredefinedSkill[],
    private readonly onChanged: () => void = () => {},
  ) {
    // Seed any missing starter, then reconcile the live store once so day one has the
    // curated set present (turned off). An existing starter is left untouched, so a
    // toggled-on or hand-edited one survives a restart rather than being reset.
    if (this.seedPredefined()) {
      this.onChanged();
    }
  }

  /**
   * A snapshot of every stored Skill for the tab, freshly read from disk. The enabled ones
   * are exactly the set the conversation injects each turn (read there from the shared
   * SkillStore), so tests assert the "shapes answers" semantic by filtering this on `enabled`.
   */
  snapshot(): SkillsSnapshot {
    return { skills: this.currentSkills() };
  }

  /** Creates a new user Skill, turned off (so "create then toggle on" is a real, visible step). */
  create(title: string, instructions: string): SkillsSnapshot {
    const id = this.mintId(title);
    this.persist({ id, title: title.trim(), instructions: instructions.trim(), enabled: false, source: "user" });
    return this.snapshot();
  }

  /**
   * Edits a user Skill's title and instructions in place, keeping its id and enabled state.
   * A no-op for a predefined starter or an unknown id - starters stay stable starting
   * points the user toggles but does not rewrite.
   */
  update(id: string, title: string, instructions: string): SkillsSnapshot {
    const current = this.find(id);
    if (current === null || current.source !== "user") {
      return this.snapshot();
    }
    this.persist({ ...current, title: title.trim(), instructions: instructions.trim() });
    return this.snapshot();
  }

  /**
   * Turns one Skill on or off (predefined and user alike) and persists the flag so it
   * survives a restart. A no-op for an unknown id, or when the flag already matches.
   */
  setEnabled(id: string, enabled: boolean): SkillsSnapshot {
    const current = this.find(id);
    if (current === null || current.enabled === enabled) {
      return this.snapshot();
    }
    this.persist({ ...current, enabled });
    return this.snapshot();
  }

  /**
   * Deletes a user Skill. A no-op for a predefined starter or an unknown id, so a starter
   * is never removed through the tab (it would only be re-seeded on the next launch).
   */
  delete(id: string): SkillsSnapshot {
    const current = this.find(id);
    if (current === null || current.source !== "user") {
      return this.snapshot();
    }
    this.files.remove(id);
    this.onChanged();
    return this.snapshot();
  }

  private find(id: string): Skill | null {
    return this.currentSkills().find((skill) => skill.id === id) ?? null;
  }

  private currentSkills(): Skill[] {
    return loadSkills(() => this.readRawFiles());
  }

  /** Writes a Skill document through the Core serializer, then reconciles the live set. */
  private persist(skill: Skill): void {
    this.files.write(skill.id, serializeSkillDocument(skill));
    this.onChanged();
  }

  /** Seeds any starter not already on disk. Returns whether anything was written. */
  private seedPredefined(): boolean {
    let seeded = false;
    for (const starter of this.predefined) {
      if (this.files.has(starter.id)) {
        continue;
      }
      this.files.write(
        starter.id,
        serializeSkillDocument({
          id: starter.id,
          title: starter.title,
          instructions: starter.instructions,
          enabled: false,
          source: "predefined",
        }),
      );
      seeded = true;
    }
    return seeded;
  }

  private readRawFiles(): RawSkillFile[] {
    return this.files.list().map((id) => ({ id, content: this.files.read(id) }));
  }

  /** A slug id from the title, uniquified against the ids already on disk (base, base-2, ...). */
  private mintId(title: string): string {
    const base = slugify(title);
    const taken = new Set(this.files.list());
    if (!taken.has(base)) {
      return base;
    }
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) {
      suffix += 1;
    }
    return `${base}-${suffix}`;
  }
}
