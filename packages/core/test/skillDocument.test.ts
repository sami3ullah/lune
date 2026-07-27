import { describe, expect, it } from "vitest";
import { parseSkillDocument, serializeSkillDocument } from "../src/skills/skillDocument.js";
import type { Skill } from "../src/skills/skillTypes.js";

// The Skill document format (M4-01): a markdown file with an optional `---`-fenced
// frontmatter (title, enabled, source) over the instructions body. Parsing is tolerant -
// the file is hand-editable and written by the Skills tab (M4-02) - and the one hard rule
// is a non-empty instructions body, since a Skill with nothing to say can't shape a reply.

describe("parseSkillDocument", () => {
  it("reads frontmatter metadata and the instructions body", () => {
    const skill = parseSkillDocument(
      "code-reviewer",
      ["---", "title: Code Reviewer", "enabled: true", "source: predefined", "---", "", "Be terse and cite line numbers."].join(
        "\n",
      ),
    );

    expect(skill).toEqual({
      id: "code-reviewer",
      title: "Code Reviewer",
      instructions: "Be terse and cite line numbers.",
      enabled: true,
      source: "predefined",
    });
  });

  it("takes the id from the caller, never from the file", () => {
    // The id is the storage filename stem, so it is always unique and not spoofable from
    // the contents - a `title` in the file names the Skill, it does not set its id.
    const skill = parseSkillDocument("my-slug", "---\ntitle: A Different Name\n---\ndo the thing");
    expect(skill?.id).toBe("my-slug");
    expect(skill?.title).toBe("A Different Name");
  });

  it("defaults a document with no frontmatter to a disabled user Skill titled by its id", () => {
    const skill = parseSkillDocument("brainstorm", "help me brainstorm wild ideas");

    expect(skill).toEqual({
      id: "brainstorm",
      title: "brainstorm",
      instructions: "help me brainstorm wild ideas",
      enabled: false,
      source: "user",
    });
  });

  it("defaults missing or partial frontmatter fields tolerantly", () => {
    const skill = parseSkillDocument("partial", "---\ntitle: Only A Title\n---\ninstructions here");
    expect(skill).toMatchObject({ title: "Only A Title", enabled: false, source: "user" });
  });

  it("treats only a literal true (any case) as enabled, everything else as disabled", () => {
    const enabled = parseSkillDocument("a", "---\nenabled: TRUE\n---\nx");
    const disabled = parseSkillDocument("b", "---\nenabled: yes\n---\nx");
    expect(enabled?.enabled).toBe(true);
    expect(disabled?.enabled).toBe(false);
  });

  it("keeps only the two known sources, defaulting an unknown one to user", () => {
    const unknown = parseSkillDocument("a", "---\nsource: wizard\n---\nx");
    expect(unknown?.source).toBe("user");
  });

  it("returns null for a document with no instructions (the one invalid case)", () => {
    expect(parseSkillDocument("empty", "")).toBeNull();
    expect(parseSkillDocument("whitespace", "   \n  \n")).toBeNull();
    expect(parseSkillDocument("metadata-only", "---\ntitle: Nothing To Say\nenabled: true\n---\n")).toBeNull();
  });

  it("treats a stray unterminated fence as body text rather than swallowing everything", () => {
    // No closing fence: the document is all instructions, not all frontmatter.
    const skill = parseSkillDocument("stray", "---\nthis looks like frontmatter but never closes");
    expect(skill?.instructions).toContain("this looks like frontmatter");
    expect(skill?.enabled).toBe(false);
  });

  it("parses CRLF documents identically to LF (hand-edits on Windows, M7)", () => {
    const skill = parseSkillDocument("crlf", "---\r\ntitle: CRLF\r\nenabled: true\r\n---\r\n\r\nline one\r\nline two");
    expect(skill).toMatchObject({ title: "CRLF", enabled: true, instructions: "line one\nline two" });
  });
});

describe("serializeSkillDocument", () => {
  const SKILL: Skill = {
    id: "code-reviewer",
    title: "Code Reviewer",
    instructions: "Be terse and cite line numbers.",
    enabled: true,
    source: "predefined",
  };

  it("round-trips a Skill through serialize -> parse losslessly", () => {
    // The tab (M4-02) writes edits via serialize; the loader reads them via parse. They
    // must agree exactly, so create/edit survives a reload unchanged (the id rides in
    // separately as the filename, so it is supplied on re-parse).
    const reparsed = parseSkillDocument(SKILL.id, serializeSkillDocument(SKILL));
    expect(reparsed).toEqual(SKILL);
  });

  it("writes the frontmatter fence, the metadata, and the trimmed instructions", () => {
    const document = serializeSkillDocument(SKILL);
    expect(document.startsWith("---\n")).toBe(true);
    expect(document).toContain("title: Code Reviewer");
    expect(document).toContain("enabled: true");
    expect(document).toContain("source: predefined");
    expect(document.trimEnd().endsWith("Be terse and cite line numbers.")).toBe(true);
  });
});
