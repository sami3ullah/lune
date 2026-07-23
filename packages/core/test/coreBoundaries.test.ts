import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Core must have no Electron and no HTTP imports so a future Swift shell or
// hosted proxy only needs a thin adapter (developer story 45; ticket 02 acceptance
// criterion). The package boundary already enforces this - @lune/core depends only
// on @lune/shared and zod - but this guard asserts it directly against the source so
// an accidental `import { app } from "electron"` or `import http from "node:http"`
// fails the suite rather than shipping.

const CORE_SOURCE_DIRECTORY = fileURLToPath(new URL("../src", import.meta.url));

/** Every forbidden module specifier, matched against each file's import/require text. */
const FORBIDDEN_IMPORT_SPECIFIERS = [
  "electron",
  "http",
  "https",
  "node:http",
  "node:https",
  "node:net",
];

/** Recursively collects every TypeScript source file under a directory. */
function collectTypeScriptFiles(directory: string): string[] {
  const collectedFiles: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectedFiles.push(...collectTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith(".ts")) {
      collectedFiles.push(entryPath);
    }
  }
  return collectedFiles;
}

/** Extracts the module specifier of every static/dynamic import and require. */
function importedSpecifiersOf(sourceText: string): string[] {
  const specifiers: string[] = [];
  const importOrRequirePattern =
    /(?:import[^'"]*from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of sourceText.matchAll(importOrRequirePattern)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

describe("Core package boundaries", () => {
  it("imports no Electron and no HTTP modules anywhere in src", () => {
    const offendingImports: string[] = [];
    for (const sourceFile of collectTypeScriptFiles(CORE_SOURCE_DIRECTORY)) {
      const specifiers = importedSpecifiersOf(readFileSync(sourceFile, "utf8"));
      for (const specifier of specifiers) {
        if (FORBIDDEN_IMPORT_SPECIFIERS.includes(specifier)) {
          offendingImports.push(`${sourceFile}: ${specifier}`);
        }
      }
    }
    expect(offendingImports).toEqual([]);
  });
});
