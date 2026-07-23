import { describe, expect, it } from "vitest";

import {
  CredentialStore,
  SecureStorageUnavailableError,
  type SecureEncryptor,
} from "../src/main/settings/credentialStore";

/**
 * Unit tests for the Vendor API-key store (ticket 13). Keys must live only in
 * OS-encrypted storage: the store persists ciphertext (never plaintext), gates Vendor
 * selectability by which keys are present, round-trips through the injected encryptor,
 * clears on an empty value, and tolerates a corrupt file. The encryptor and filesystem
 * are injected so the seam is testable without a real keychain.
 */

/** A reversible fake encryptor: "encrypts" by prefixing so plaintext is never on disk verbatim. */
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

/** An in-memory filesystem backing the store, so a test can inspect what was written. */
function inMemoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set("/creds.json", initial);
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
  return new CredentialStore("/creds.json", encryptor, fs.read, fs.write);
}

describe("CredentialStore", () => {
  it("starts with no keyed Vendors when no file exists", () => {
    const store = makeStore(fakeEncryptor(), inMemoryFs());
    expect(store.keyedVendors()).toEqual([]);
    expect(store.getKey("anthropic")).toBeUndefined();
  });

  it("stores a key as ciphertext (never plaintext) and round-trips it", () => {
    const fs = inMemoryFs();
    const store = makeStore(fakeEncryptor(), fs);
    store.setKey("anthropic", "sk-secret-123");

    expect(store.getKey("anthropic")).toBe("sk-secret-123");
    expect(store.hasKey("anthropic")).toBe(true);
    expect(store.keyedVendors()).toEqual(["anthropic"]);
    // The persisted file must not contain the raw secret.
    expect(fs.files.get("/creds.json")).not.toContain("sk-secret-123");
  });

  it("gates selectability: only Vendors with a stored key are keyed", () => {
    const store = makeStore(fakeEncryptor(), inMemoryFs());
    store.setKey("google", "g-key");
    store.setKey("openai", "o-key");
    expect(store.keyedVendors().sort()).toEqual(["google", "openai"]);
    expect(store.hasKey("anthropic")).toBe(false);
  });

  it("clears a key when set to empty/blank", () => {
    const store = makeStore(fakeEncryptor(), inMemoryFs());
    store.setKey("google", "g-key");
    store.setKey("google", "   ");
    expect(store.hasKey("google")).toBe(false);
    expect(store.getKey("google")).toBeUndefined();
  });

  it("persists across a reload from the same file", () => {
    const fs = inMemoryFs();
    makeStore(fakeEncryptor(), fs).setKey("openai", "o-key");
    // A fresh store reading the same file sees the stored key.
    const reloaded = makeStore(fakeEncryptor(), fs);
    expect(reloaded.getKey("openai")).toBe("o-key");
  });

  it("throws when secure storage is unavailable, never writing plaintext", () => {
    const fs = inMemoryFs();
    const store = makeStore(fakeEncryptor(false), fs);
    expect(() => store.setKey("anthropic", "sk-secret")).toThrow(SecureStorageUnavailableError);
    expect(store.hasKey("anthropic")).toBe(false);
    expect(fs.files.get("/creds.json")).toBeUndefined();
  });

  it("tolerates a corrupt file as no keys", () => {
    const store = makeStore(fakeEncryptor(), inMemoryFs("not json{"));
    expect(store.keyedVendors()).toEqual([]);
  });

  it("treats an undecryptable stored entry as absent", () => {
    // A file whose ciphertext was written by a different encryptor.
    const fs = inMemoryFs(JSON.stringify({ anthropic: Buffer.from("garbage", "utf8").toString("base64") }));
    const store = makeStore(fakeEncryptor(), fs);
    // It counts as "keyed" (an entry exists) but decryption yields undefined.
    expect(store.getKey("anthropic")).toBeUndefined();
  });
});
