import type { SettingsVendorId } from "../../ipc/settings";
import { SETTINGS_VENDOR_IDS } from "../../ipc/settings";

// The Vendor API-key store (ticket 13 acceptance: "keys live only in encrypted OS
// storage"). Keys are never written to the config file (which the Core reads and holds
// no secrets) - they are encrypted with the OS keychain-backed secure store and
// persisted as ciphertext, then decrypted in-process and handed to the Core's
// `getApiKey` seam. This is the Lune counterpart of v1's `SnappyKeychainStore` (macOS
// Security-framework generic-password items), reimplemented on Electron's `safeStorage`
// so it carries to the M7 Windows port unchanged.
//
// The secure encryptor and the filesystem are injected rather than imported, so the
// store is a thin, testable seam over pure ciphertext<->plaintext coding: the main
// process supplies Electron's real `safeStorage` and `fs`; a test supplies fakes.

/**
 * The secure-encryptor seam, matching the subset of Electron's `safeStorage` this
 * store uses so the main process can inject `safeStorage` directly. Encryption is
 * backed by the OS keychain, so ciphertext on disk is meaningless without the user's
 * login session.
 */
export interface SecureEncryptor {
  /** Whether OS-backed encryption is available (false on a misconfigured Linux keyring). */
  isEncryptionAvailable(): boolean;
  /** Encrypts a key to opaque ciphertext bytes. */
  encryptString(plainText: string): Buffer;
  /** Decrypts ciphertext bytes produced by {@link encryptString}. */
  decryptString(encrypted: Buffer): string;
}

/** Reads the persisted credentials file, or throws if it is absent. */
export type ReadCredentialsFile = (filePath: string) => string;
/** Writes the persisted credentials file (best-effort). */
export type WriteCredentialsFile = (filePath: string, contents: string) => void;

/** Thrown by {@link CredentialStore.setKey} when the OS secure store is unavailable. */
export class SecureStorageUnavailableError extends Error {
  constructor() {
    super("Secure storage is not available; the API key cannot be stored safely");
    this.name = "SecureStorageUnavailableError";
  }
}

const VALID_VENDOR_IDS: ReadonlySet<string> = new Set(SETTINGS_VENDOR_IDS);

/**
 * Stores each Vendor's API key as OS-encrypted ciphertext, keyed by Vendor id. Adding
 * or clearing a key persists immediately and is reflected by {@link keyedVendors} on
 * the next read, so the Settings picker gates Vendor selectability the moment a key
 * changes.
 */
export class CredentialStore {
  /** The persisted map: Vendor id -> base64 of the encrypted key. */
  private cipherByVendor: Map<SettingsVendorId, string>;

  constructor(
    private readonly filePath: string,
    private readonly encryptor: SecureEncryptor,
    private readonly readFile: ReadCredentialsFile,
    private readonly writeFile: WriteCredentialsFile,
  ) {
    this.cipherByVendor = this.load();
  }

  /** The Vendors that currently have a stored key (drives picker selectability). */
  keyedVendors(): SettingsVendorId[] {
    return SETTINGS_VENDOR_IDS.filter((vendorId) => this.cipherByVendor.has(vendorId));
  }

  /** Whether one Vendor currently has a stored key. */
  hasKey(vendorId: SettingsVendorId): boolean {
    return this.cipherByVendor.has(vendorId);
  }

  /**
   * The decrypted key for one Vendor, or `undefined` when none is stored (or the
   * ciphertext cannot be decrypted - a corrupt entry gates the Vendor off rather than
   * crashing the Core's per-turn key lookup).
   */
  getKey(vendorId: SettingsVendorId): string | undefined {
    const cipher = this.cipherByVendor.get(vendorId);
    if (cipher === undefined) {
      return undefined;
    }
    try {
      const decrypted = this.encryptor.decryptString(Buffer.from(cipher, "base64"));
      return decrypted.length > 0 ? decrypted : undefined;
    } catch (error) {
      console.error(`[lune] could not decrypt stored ${vendorId} key:`, error);
      return undefined;
    }
  }

  /**
   * Sets (non-empty) or clears (empty/blank) one Vendor's key, encrypting it with the
   * OS secure store and persisting immediately. Throws
   * {@link SecureStorageUnavailableError} when encryption is unavailable, so a key is
   * never written unencrypted.
   */
  setKey(vendorId: SettingsVendorId, key: string): void {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      this.cipherByVendor.delete(vendorId);
      this.persist();
      return;
    }
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new SecureStorageUnavailableError();
    }
    const cipher = this.encryptor.encryptString(trimmed).toString("base64");
    this.cipherByVendor.set(vendorId, cipher);
    this.persist();
  }

  /** Loads the persisted ciphertext map, tolerating an absent or corrupt file. */
  private load(): Map<SettingsVendorId, string> {
    const loaded = new Map<SettingsVendorId, string>();
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
    for (const [vendorId, cipher] of Object.entries(parsed as Record<string, unknown>)) {
      if (VALID_VENDOR_IDS.has(vendorId) && typeof cipher === "string" && cipher.length > 0) {
        loaded.set(vendorId as SettingsVendorId, cipher);
      }
    }
    return loaded;
  }

  /**
   * Persists the ciphertext map. A write failure is swallowed (a lost key next launch
   * is re-enterable in Settings and never worth crashing a mid-conversation app), but
   * logged.
   */
  private persist(): void {
    const serialized: Record<string, string> = {};
    for (const [vendorId, cipher] of this.cipherByVendor) {
      serialized[vendorId] = cipher;
    }
    try {
      this.writeFile(this.filePath, JSON.stringify(serialized));
    } catch (error) {
      console.error("[lune] could not persist API keys:", error);
    }
  }
}
