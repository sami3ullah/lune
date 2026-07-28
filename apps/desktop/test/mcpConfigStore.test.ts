import { describe, expect, it } from "vitest";

import { McpConfigStore, type StoredIntegration } from "../src/main/integrations/mcpConfigStore";

/**
 * Unit tests for the integrations config store (M6-02). It persists the secret-free list of
 * added integrations, is tolerant of a corrupt/partial file (a well-formed neighbour still
 * loads), and round-trips add/remove/update. It must never accept an entry with neither a
 * preset nor a custom transport (nothing to connect), and must keep the file secret-free.
 */

function inMemoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set("/integrations.json", initial);
  }
  return {
    files,
    read: (path: string): string => {
      const contents = files.get(path);
      if (contents === undefined) {
        throw new Error("ENOENT");
      }
      return contents;
    },
    write: (path: string, contents: string): void => {
      files.set(path, contents);
    },
  };
}

function makeStore(fs: ReturnType<typeof inMemoryFs>) {
  return new McpConfigStore("/integrations.json", fs.read, fs.write);
}

const spotify: StoredIntegration = {
  id: "spotify",
  presetId: "spotify",
  displayName: "Spotify",
  category: "music",
  enabled: true,
};

describe("McpConfigStore", () => {
  it("starts empty when no file exists", () => {
    expect(makeStore(inMemoryFs()).all()).toEqual([]);
  });

  it("adds, reads back, and persists an entry", () => {
    const fs = inMemoryFs();
    const store = makeStore(fs);
    store.add(spotify);

    expect(store.all()).toEqual([spotify]);
    expect(store.get("spotify")).toEqual(spotify);
    // A fresh store over the same file sees it.
    expect(makeStore(fs).all()).toEqual([spotify]);
  });

  it("ignores a duplicate add and keeps insertion order", () => {
    const store = makeStore(inMemoryFs());
    store.add(spotify);
    store.add({ ...spotify, displayName: "Spotify 2" });
    store.add({ id: "obsidian", presetId: "obsidian", displayName: "Obsidian", category: "notes", enabled: false });
    expect(store.all().map((e) => e.id)).toEqual(["spotify", "obsidian"]);
    expect(store.get("spotify")?.displayName).toBe("Spotify");
  });

  it("updates a field in place and removes an entry", () => {
    const store = makeStore(inMemoryFs());
    store.add(spotify);
    store.update("spotify", { enabled: false });
    expect(store.get("spotify")?.enabled).toBe(false);
    store.remove("spotify");
    expect(store.all()).toEqual([]);
  });

  it("round-trips a custom (non-preset) server", () => {
    const fs = inMemoryFs();
    const custom: StoredIntegration = {
      id: "custom-local",
      displayName: "My server",
      category: "developer",
      enabled: true,
      customTransport: { kind: "stdio", command: "my-mcp", args: ["--flag"] },
    };
    makeStore(fs).add(custom);
    expect(makeStore(fs).get("custom-local")).toEqual(custom);
  });

  it("skips a malformed entry but keeps its well-formed neighbours", () => {
    const raw = JSON.stringify({
      integrations: [
        { id: "", displayName: "no id", presetId: "x" }, // empty id -> dropped
        { id: "orphan", displayName: "no transport or preset" }, // neither preset nor custom -> dropped
        spotify, // valid -> kept
      ],
    });
    expect(makeStore(inMemoryFs(raw)).all()).toEqual([spotify]);
  });

  it("tolerates a corrupt file as an empty list", () => {
    expect(makeStore(inMemoryFs("garbage{")).all()).toEqual([]);
  });
});
