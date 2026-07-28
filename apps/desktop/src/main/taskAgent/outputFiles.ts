import type { OutputFileFormat } from "@lune/core";

// The pure helpers behind the Task Agent's file-writing platform (M5-02): resolving a
// model-chosen filename to a safe basename, and turning a note/PDF's text content into the
// HTML a hidden window prints to PDF. Kept pure and separate from the fs/Electron edges so
// the naming rules and the PDF markup are unit-tested without touching disk.
//
// File outputs land in a predictable, user-visible location (the "Lune" folder under the
// user's Documents - acceptance #3); this module owns the *name* within that folder, the
// caller owns the folder.

/**
 * Control characters and the punctuation illegal or awkward in a filename on common OSes.
 * Path separators are already gone (the caller keeps only the last path segment), so this
 * need not list them. Every member is a literal except the intended control-char range
 * `\x00-\x1f`, so the class means the same in every regex engine - an earlier ` -<` form
 * was an accidental range some engines read as "strip spaces, dots, and digits".
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_FILENAME_CHARS = /[\x00-\x1f<>:"|?*]/g;

/**
 * Reduces a model-chosen filename to a safe basename inside the output folder: strips any
 * directory components (so `../../etc/passwd` can't escape the folder), drops characters
 * that are illegal or awkward in a filename, and falls back to a default when nothing
 * usable remains. Never returns a path separator, so the result is always a single file in
 * the output folder.
 */
export function sanitizeOutputFilename(rawName: string, fallback = "lune-output.txt"): string {
  // Take only the last path segment, so directory traversal is impossible.
  const lastSegment = rawName.split(/[\\/]/).pop() ?? "";
  const cleaned = lastSegment
    .replace(ILLEGAL_FILENAME_CHARS, "")
    // Collapse whitespace runs to a single space and trim.
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot would make a hidden file with no visible name; strip leading dots.
    .replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The default file extension for a format, appended by {@link ensureExtension} when the
 * chosen filename lacks a matching one.
 */
const DEFAULT_EXTENSION: Record<OutputFileFormat, string> = {
  text: ".txt",
  markdown: ".md",
  pdf: ".pdf",
  csv: ".csv",
};

/** All extensions a given format accepts (so a `.markdown` note isn't renamed to `.md`). */
const ACCEPTED_EXTENSIONS: Record<OutputFileFormat, readonly string[]> = {
  text: [".txt", ".text"],
  markdown: [".md", ".markdown"],
  pdf: [".pdf"],
  csv: [".csv"],
};

/**
 * Ensures a filename carries an extension appropriate to its format, appending the default
 * one when it doesn't - so a "shopping list" note saved as markdown becomes
 * `shopping list.md` and opens in the right app.
 */
export function ensureExtension(filename: string, format: OutputFileFormat): string {
  const lower = filename.toLowerCase();
  const accepted = ACCEPTED_EXTENSIONS[format];
  if (accepted.some((extension) => lower.endsWith(extension))) {
    return filename;
  }
  return `${filename}${DEFAULT_EXTENSION[format]}`;
}

/** HTML-escapes text so it renders literally in the printed PDF (no markup injection). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wraps a note's text content in a minimal, self-contained HTML document for printing to
 * PDF. The content is treated as plain text (HTML-escaped, newlines preserved) rather than
 * rendered markup, so whatever the model wrote is exactly what the user sees - no surprise
 * markdown injection or broken layout. The styling is a readable serif page with sane
 * margins; the caller feeds this to a hidden window's `printToPDF`.
 */
export function buildPdfHtml(content: string): string {
  const escaped = escapeHtml(content).replace(/\r?\n/g, "<br>");
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<style>" +
    "body{font-family:-apple-system,Georgia,serif;font-size:13pt;line-height:1.5;" +
    "margin:48px;color:#111;}" +
    "</style></head><body>" +
    escaped +
    "</body></html>"
  );
}
