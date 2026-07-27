/**
 * The on-disk format of a Skill: a markdown file whose optional `---`-fenced
 * frontmatter carries the metadata (`title`, `enabled`, `source`) and whose body is
 * the instructions. This module is the single authority for that format - it both
 * reads it (`parseSkillDocument`) and writes it (`serializeSkillDocument`), so the
 * Skills tab editor (M4-02) round-trips the exact same shape the loader accepts.
 *
 * Parsing is tolerant, mirroring `routingConfig`: the file is user-facing (hand-edited
 * or written by the tab), so a missing or partial frontmatter still yields a usable
 * Skill by falling back to defaults. A flat `key: value` frontmatter (not nested YAML)
 * keeps the Core dependency-free - three scalar keys need no YAML parser.
 *
 * The one hard validity rule is a non-empty instructions body: a Skill with nothing to
 * say cannot shape an answer, so an empty document parses to `null` and the store skips
 * it. The `id` is supplied by the caller (the storage filename stem), never read from
 * the file, so it is always unique and never spoofable from the file contents.
 */
import type { Skill, SkillSource } from "./skillTypes.js";

/** The frontmatter fence line; a document may open with one to carry metadata. */
const FRONTMATTER_FENCE = "---";

/** The metadata keys the frontmatter understands; anything else is ignored. */
type FrontmatterFields = {
  title?: string;
  enabled?: boolean;
  source?: SkillSource;
};

/**
 * Splits a raw document into its frontmatter text (if any) and the body. A document
 * opens with frontmatter only when its very first line is the fence and a matching
 * closing fence follows; otherwise the whole document is the body (no metadata).
 */
function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  // Normalize newlines so a CRLF file (a hand-edit on Windows, M7) parses identically.
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { frontmatter: null, body: normalized };
  }

  // Find the closing fence; without one, treat the document as bodyless-metadata-less
  // text rather than swallowing everything as frontmatter (tolerant of a stray fence).
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
  if (closingIndex === -1) {
    return { frontmatter: null, body: normalized };
  }

  return {
    frontmatter: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

/** Reads a boolean frontmatter value tolerantly: only a literal `true` (any case) is true. */
function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

/** Reads the `source` value, keeping only the two known values and defaulting to "user". */
function parseSource(value: string): SkillSource {
  return value.trim().toLowerCase() === "predefined" ? "predefined" : "user";
}

/** Parses a flat `key: value` frontmatter block into the fields we understand. */
function parseFrontmatter(frontmatter: string): FrontmatterFields {
  const fields: FrontmatterFields = {};
  for (const line of frontmatter.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === "title") {
      fields.title = value;
    } else if (key === "enabled") {
      fields.enabled = parseBoolean(value);
    } else if (key === "source") {
      fields.source = parseSource(value);
    }
  }
  return fields;
}

/**
 * Parses one Skill document. The `id` is the storage filename stem (the caller owns it;
 * it is never read from the file). Returns `null` for a document with no instructions -
 * the one invalid case the store skips - so a blank or metadata-only file never becomes
 * a Skill that injects nothing.
 */
export function parseSkillDocument(id: string, raw: string): Skill | null {
  const { frontmatter, body } = splitFrontmatter(raw);
  const instructions = body.trim();
  if (instructions.length === 0) {
    return null;
  }

  const fields = frontmatter === null ? {} : parseFrontmatter(frontmatter);
  const title = fields.title !== undefined && fields.title.length > 0 ? fields.title : id;

  return {
    id,
    title,
    instructions,
    enabled: fields.enabled ?? false,
    source: fields.source ?? "user",
  };
}

/**
 * Serializes a Skill back to its document form, the exact shape {@link parseSkillDocument}
 * reads. The Skills tab (M4-02) writes edits through this, so a Skill with a single-line
 * title round-trips losslessly. The frontmatter is one `key: value` per line, so the
 * title is normalized to a single line (its newlines collapsed to spaces) to keep the
 * block well-formed no matter what the caller passes - the instructions body, below the
 * fence, keeps its newlines. The `id` is not written - it is the filename, supplied on load.
 */
export function serializeSkillDocument(skill: Skill): string {
  const singleLineTitle = skill.title.replace(/[\r\n]+/g, " ").trim();
  const frontmatter = [
    FRONTMATTER_FENCE,
    `title: ${singleLineTitle}`,
    `enabled: ${skill.enabled}`,
    `source: ${skill.source}`,
    FRONTMATTER_FENCE,
  ].join("\n");
  return `${frontmatter}\n\n${skill.instructions.trim()}\n`;
}
