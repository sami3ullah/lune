import { describe, expect, it } from "vitest";

import {
  buildPdfHtml,
  ensureExtension,
  sanitizeOutputFilename,
} from "../src/main/taskAgent/outputFiles";

// The pure file-naming and PDF-markup rules behind the Task Agent's `write_file` platform
// (M5-02). The safety-relevant one is that a model-chosen filename can never escape the
// output folder; the rest keep the file openable and the PDF faithful to the text.

describe("sanitizeOutputFilename", () => {
  it("keeps an ordinary filename intact", () => {
    expect(sanitizeOutputFilename("shopping list.md")).toBe("shopping list.md");
  });

  it("preserves spaces, dots, hyphens, and digits (guards against an over-broad char range)", () => {
    expect(sanitizeOutputFilename("report 2024-Q3 v1.5.pdf")).toBe("report 2024-Q3 v1.5.pdf");
  });

  it("strips directory components so a write can never escape the output folder", () => {
    expect(sanitizeOutputFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOutputFilename("/Users/me/.ssh/id_rsa")).toBe("id_rsa");
    expect(sanitizeOutputFilename("a/b/c/note.txt")).toBe("note.txt");
  });

  it("drops illegal characters and leading dots", () => {
    expect(sanitizeOutputFilename('bad:name"?.txt')).toBe("badname.txt");
    expect(sanitizeOutputFilename("...hidden")).toBe("hidden");
  });

  it("falls back to a default when nothing usable remains", () => {
    expect(sanitizeOutputFilename("///")).toBe("lune-output.txt");
    expect(sanitizeOutputFilename("   ")).toBe("lune-output.txt");
  });
});

describe("ensureExtension", () => {
  it("appends the format's default extension when missing", () => {
    expect(ensureExtension("shopping list", "markdown")).toBe("shopping list.md");
    expect(ensureExtension("report", "pdf")).toBe("report.pdf");
    expect(ensureExtension("rows", "csv")).toBe("rows.csv");
    expect(ensureExtension("note", "text")).toBe("note.txt");
  });

  it("leaves a filename that already has an accepted extension unchanged", () => {
    expect(ensureExtension("a.md", "markdown")).toBe("a.md");
    expect(ensureExtension("a.markdown", "markdown")).toBe("a.markdown");
    expect(ensureExtension("a.PDF", "pdf")).toBe("a.PDF");
  });
});

describe("buildPdfHtml", () => {
  it("escapes HTML so the note's text is shown literally, and preserves line breaks", () => {
    const html = buildPdfHtml("Buy <milk> & bread\nCall Sam");
    expect(html).toContain("Buy &lt;milk&gt; &amp; bread<br>Call Sam");
    expect(html).not.toContain("<milk>");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
});
