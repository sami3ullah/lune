import { describe, expect, it } from "vitest";

import { McpSecretStore } from "../src/main/integrations/mcpSecretStore";
import { SecureStorageUnavailableError, type SecureEncryptor } from "../src/main/settings/credentialStore";

/**
 * Unit tests for the MCP integrations secret store (M6-02). Like the Vendor-key store, every
 * value lives only as OS-encrypted ciphertext (never plaintext on disk), round-trips through
 * the injected encryptor, clears on empty, and tolerates a corrupt file. The extra behaviour
 * this store carries is a free-form key space and `removeByPrefix`, which backs "removing an
 * integration cleans up its secrets fully" (acceptance #2).
 */

function fakeEncryptor(available = true): SecureEncryptor {
  const PREFIX = "enc::";
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(PREFIX + plainText, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith(PREFIX)) {
        throw new Error("not encrypted by this encryptor");
      }
      return text.slice(PREFIX.length);
    },
  };
}

function inMemoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set("/secrets.json", initial);
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

function makeStore(encryptor: SecureEncryptor, fs: ReturnType<typeof inMemoryFs>) {
  return new McpSecretStore("/secrets.json", encryptor, fs.read, fs.write);
}

describe("McpSecretStore", () => {
  it("stores a value as ciphertext (never plaintext) and round-trips it", () => {
    const fs = inMemoryFs();
    const store = makeStore(fakeEncryptor(), fs);
    store.set("spotify::cred::clientSecret", "super-secret");

    expect(store.get("spotify::cred::clientSecret")).toBe("super-secret");
    expect(store.has("spotify::cred::clientSecret")).toBe(true);
    expect(fs.files.get("/secrets.json")).not.toContain("super-secret");
  });

  it("clears a value when set to empty/blank", () => {
    const store = makeStore(fakeEncryptor(), inMemoryFs());
    store.set("obsidian::cred::vaultPath", "/vault");
    store.set("obsidian::cred::vaultPath", "   ");
    expect(store.has("obsidian::cred::vaultPath")).toBe(false);
    expect(store.get("obsidian::cred::vaultPath")).toBeUndefined();
  });

  it("removes every value for one integration by prefix", () => {
    const store = makeStore(fakeEncryptor(), inMemoryFs());
    store.set("gmail::oauth", "token-bundle");
    store.set("gmail::cred::clientId", "abc");
    store.set("spotify::cred::clientId", "keep-me");

    store.removeByPrefix("gmail::");

    expect(store.has("gmail::oauth")).toBe(false);
    expect(store.has("gmail::cred::clientId")).toBe(false);
    // A different integration's secrets are untouched.
    expect(store.get("spotify::cred::clientId")).toBe("keep-me");
  });

  it("persists across a reload from the same file", () => {
    const fs = inMemoryFs();
    makeStore(fakeEncryptor(), fs).set("google-sheets::oauth", "tok");
    const reloaded = makeStore(fakeEncryptor(), fs);
    expect(reloaded.get("google-sheets::oauth")).toBe("tok");
  });

  it("throws when secure storage is unavailable, never writing plaintext", () => {
    const fs = inMemoryFs();
    const store = makeStore(fakeEncryptor(false), fs);
    expect(() => store.set("spotify::cred::clientSecret", "nope")).toThrow(SecureStorageUnavailableError);
    expect(store.has("spotify::cred::clientSecret")).toBe(false);
    expect(fs.files.get("/secrets.json")).toBeUndefined();
  });

  it("tolerates a corrupt file as no secrets", () => {
    const store = makeStore(fakeEncryptor(), inMemoryFs("not json{"));
    expect(store.has("anything")).toBe(false);
  });
});
