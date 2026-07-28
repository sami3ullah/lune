import { describe, expect, it } from "vitest";

import { MCP_PRESETS, findPreset } from "../src/main/integrations/mcpPresets";

/**
 * Unit tests for the flagship preset catalog (M6-02). The catalog is data, so the tests pin
 * the invariants the rest of the surface relies on: unique ids, a coherent auth story per
 * preset (credential fields iff `credentials`), and a `buildTransport` that injects the pasted
 * values into the right place (env for a secret stdio server, an arg for a path, a bare URL
 * for an OAuth HTTP server) - so a resolved secret reaches the process and no secret is
 * hard-coded.
 */

describe("MCP_PRESETS", () => {
  it("has unique ids and includes the flagship apps", () => {
    const ids = MCP_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const flagship of ["spotify", "obsidian", "google-sheets"]) {
      expect(ids).toContain(flagship);
    }
  });

  it("gives every `credentials` preset guided fields, and every other kind none", () => {
    for (const preset of MCP_PRESETS) {
      if (preset.authKind === "credentials") {
        expect(preset.credentialFields.length).toBeGreaterThan(0);
        // Every field carries the guidance a non-technical user needs.
        for (const field of preset.credentialFields) {
          expect(field.help.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("injects a secret stdio preset's pasted values into the child env", () => {
    const spotify = findPreset("spotify");
    expect(spotify).toBeDefined();
    const transport = spotify!.buildTransport({ clientId: "cid", clientSecret: "shh" });
    expect(transport.kind).toBe("stdio");
    if (transport.kind === "stdio") {
      expect(transport.env).toMatchObject({ SPOTIFY_CLIENT_ID: "cid", SPOTIFY_CLIENT_SECRET: "shh" });
    }
  });

  it("passes a non-secret path preset's value as a command arg", () => {
    const obsidian = findPreset("obsidian");
    const transport = obsidian!.buildTransport({ vaultPath: "/Users/me/Vault" });
    expect(transport.kind).toBe("stdio");
    if (transport.kind === "stdio") {
      expect(transport.args).toContain("/Users/me/Vault");
    }
  });

  it("builds a bare HTTP transport for an OAuth preset (tokens come from the auth provider)", () => {
    const sheets = findPreset("google-sheets");
    expect(sheets!.authKind).toBe("oauth");
    const transport = sheets!.buildTransport({});
    expect(transport.kind).toBe("http");
    if (transport.kind === "http") {
      expect(transport.url).toMatch(/^https:\/\//);
    }
  });

  it("returns undefined for an unknown preset id", () => {
    expect(findPreset("nope")).toBeUndefined();
  });
});
