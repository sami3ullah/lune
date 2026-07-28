import type {
  ReadCredentialsFile,
  SecureEncryptor,
  WriteCredentialsFile,
} from "../settings/credentialStore";
import { SecureStorageUnavailableError } from "../settings/credentialStore";

// The MCP integrations secret store (M6-02): every credential an integration needs - a pasted
// API key or client secret, a non-secret setup value like an Obsidian vault path, and the
// OAuth token bundle a sign-in yields - lives here as OS-encrypted ciphertext, never in the
// integrations config file (which the manager reads and holds no secrets). It is the direct
// analogue of the Vendor-key `CredentialStore`, reusing its `safeStorage`-backed encryptor
// seam and injected filesystem; the only difference is the key space. Where the Vendor store
// keys by a fixed Vendor id, an integration has arbitrary many values, so this keys by a
// free-form string (`<integrationId>::cred::<field>` for a guided value, `<integrationId>::oauth`
// for the token bundle). Storing even the non-secret values encrypted keeps the on-disk config
// provably secret-free (the whole point of acceptance #2), at the negligible cost of
// encrypting a vault path.
//
// The encryptor and filesystem are injected, not imported, so this stays a thin, testable
// seam over pure ciphertext<->plaintext coding: the main process supplies Electron's real
// `safeStorage` and `fs`; a test supplies fakes.

/**
 * Stores an integration's secrets as OS-encrypted ciphertext, keyed by a free-form string.
 * Setting or clearing a value persists immediately. `removeByPrefix` drops every value for one
 * integration in a single write, so removing an integration cleans up its secrets fully
 * (acceptance #2).
 */
export class McpSecretStore {
  /** The persisted map: key -> base64 of the encrypted value. */
  private cipherByKey: Map<string, string>;

  constructor(
    private readonly filePath: string,
    private readonly encryptor: SecureEncryptor,
    private readonly readFile: ReadCredentialsFile,
    private readonly writeFile: WriteCredentialsFile,
  ) {
    this.cipherByKey = this.load();
  }

  /** Whether a value is stored for this key. */
  has(key: string): boolean {
    return this.cipherByKey.has(key);
  }

  /**
   * The decrypted value for one key, or `undefined` when none is stored (or the ciphertext
   * cannot be decrypted - a corrupt entry reads as absent rather than crashing a connect).
   */
  get(key: string): string | undefined {
    const cipher = this.cipherByKey.get(key);
    if (cipher === undefined) {
      return undefined;
    }
    try {
      const decrypted = this.encryptor.decryptString(Buffer.from(cipher, "base64"));
      return decrypted.length > 0 ? decrypted : undefined;
    } catch (error) {
      console.error(`[lune] could not decrypt stored integration secret '${key}':`, error);
      return undefined;
    }
  }

  /**
   * Sets (non-empty) or clears (empty/blank) one value, encrypting it with the OS secure store
   * and persisting immediately. Throws {@link SecureStorageUnavailableError} when encryption is
   * unavailable, so a secret is never written unencrypted.
   */
  set(key: string, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (this.cipherByKey.delete(key)) {
        this.persist();
      }
      return;
    }
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new SecureStorageUnavailableError();
    }
    this.cipherByKey.set(key, this.encryptor.encryptString(trimmed).toString("base64"));
    this.persist();
  }

  /** Removes one value; a no-op if it is already absent. */
  remove(key: string): void {
    if (this.cipherByKey.delete(key)) {
      this.persist();
    }
  }

  /** Removes every stored value whose key starts with `prefix` (one integration's whole set). */
  removeByPrefix(prefix: string): void {
    let changed = false;
    for (const key of [...this.cipherByKey.keys()]) {
      if (key.startsWith(prefix)) {
        this.cipherByKey.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  /** Loads the persisted ciphertext map, tolerating an absent or corrupt file. */
  private load(): Map<string, string> {
    const loaded = new Map<string, string>();
    let raw: string;
    try {
      raw = this.readFile(this.filePath);
    } catch {
      return loaded;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return loaded;
    }
    if (parsed === null || typeof parsed !== "object") {
      return loaded;
    }
    for (const [key, cipher] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof cipher === "string" && cipher.length > 0) {
        loaded.set(key, cipher);
      }
    }
    return loaded;
  }

  /**
   * Persists the ciphertext map. A write failure is swallowed (a lost secret next launch is
   * re-enterable in Settings and never worth crashing a mid-conversation app), but logged.
   */
  private persist(): void {
    const serialized: Record<string, string> = {};
    for (const [key, cipher] of this.cipherByKey) {
      serialized[key] = cipher;
    }
    try {
      this.writeFile(this.filePath, JSON.stringify(serialized));
    } catch (error) {
      console.error("[lune] could not persist integration secrets:", error);
    }
  }
}
