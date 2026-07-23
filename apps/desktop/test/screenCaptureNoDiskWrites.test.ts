import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ticket 05 acceptance: screenshots are never persisted to disk. The capture path
// keeps them only as in-memory base64 handed to the in-process Core. This guard
// asserts that directly against the source, so a future edit that reaches for the
// filesystem (a debug dump, a cache) in the screen-capture layer fails here rather
// than quietly writing sensitive screen pixels to disk.

const SCREEN_CAPTURE_SOURCE_FILES = [
  "../src/main/screenCapture/captureDisplays.ts",
  "../src/main/screenCapture/screenLabeling.ts",
  "../src/main/screenCapture/screenPermissionState.ts",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

/** Filesystem-write specifiers and APIs that would let a screenshot reach the disk. */
const FORBIDDEN_DISK_WRITE_PATTERNS = [
  /\bfrom\s+['"]node:fs['"]/,
  /\bfrom\s+['"]fs['"]/,
  /\brequire\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/,
  /\bwriteFile\b/,
  /\bwriteFileSync\b/,
  /\bcreateWriteStream\b/,
  /\bappendFile\b/,
  /\.toDataURL\(/, // not a disk write, but a common step toward one - flag it too
];

describe("screen capture never persists to disk", () => {
  it("uses no filesystem-write APIs anywhere in the capture layer", () => {
    const offendingReferences: string[] = [];
    for (const sourceFile of SCREEN_CAPTURE_SOURCE_FILES) {
      const sourceText = readFileSync(sourceFile, "utf8");
      for (const forbiddenPattern of FORBIDDEN_DISK_WRITE_PATTERNS) {
        if (forbiddenPattern.test(sourceText)) {
          offendingReferences.push(`${sourceFile}: ${forbiddenPattern}`);
        }
      }
    }
    expect(offendingReferences).toEqual([]);
  });
});
