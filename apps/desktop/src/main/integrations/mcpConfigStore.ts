import type { CustomTransport, IntegrationCategory } from "../../ipc/integrations";
import { IntegrationCategorySchema, CustomTransportSchema } from "../../ipc/integrations";

// The integrations config store (M6-02): the Shell's persisted, secret-free record of which
// integrations the user has added and whether each is turned on. It is the integrations
// analogue of `SettingsStore` over its own `integrations.json` under userData - a plain JSON
// document the Shell is the sole writer of. Secrets (API keys, OAuth tokens, even a vault
// path) never appear here; they live in the OS-encrypted `McpSecretStore`. The Core's
// `McpServerManager` is handed fully-resolved server configs (secrets injected at connect
// time) built from this record plus the secret store, and never reads this file itself.
//
// Loading is deliberately tolerant: a malformed file, or an entry missing required fields,
// is skipped rather than crashing a launch - a returning user with a hand-corrupted file
// still gets every well-formed integration back.

/**
 * One added integration as persisted on disk. A preset instance carries its `presetId` (the
 * transport is rebuilt from the preset at connect time); a custom server carries its own
 * `customTransport`. Exactly one of the two is present.
 */
export interface StoredIntegration {
  /** Unique instance id. For a preset this equals the preset id; for a custom server, a minted slug. */
  id: string;
  /** The preset this was added from, if any (absent for a custom server). */
  presetId?: string;
  /** The human label shown in Settings and spoken by the Confirm Gate. */
  displayName: string;
  /** The catalog grouping, carried so a custom server still sorts sensibly. */
  category: IntegrationCategory;
  /** Whether the manager should connect it. */
  enabled: boolean;
  /** A custom (non-preset) server's transport; absent for a preset. */
  customTransport?: CustomTransport;
}

/** Reads the persisted config file, or throws if it is absent (mirrors `fs`). */
export type ReadConfigFile = (filePath: string) => string;
/** Writes the persisted config file (best-effort). */
export type WriteConfigFile = (filePath: string, contents: string) => void;

/**
 * Stores the ordered list of added integrations as JSON. Every mutation persists immediately
 * and returns the new list, so the service always works from one consistent view.
 */
export class McpConfigStore {
  private entries: StoredIntegration[];

  constructor(
    private readonly filePath: string,
    private readonly readFile: ReadConfigFile,
    private readonly writeFile: WriteConfigFile,
  ) {
    this.entries = this.load();
  }

  /** Every added integration, in insertion order. */
  all(): StoredIntegration[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** One added integration by id, or `undefined`. */
  get(id: string): StoredIntegration | undefined {
    const found = this.entries.find((entry) => entry.id === id);
    return found ? { ...found } : undefined;
  }

  /** Whether an integration with this id is already added. */
  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id);
  }

  /** Adds a new integration (appended). A no-op if the id is already present. */
  add(entry: StoredIntegration): void {
    if (this.has(entry.id)) {
      return;
    }
    this.entries.push({ ...entry });
    this.persist();
  }

  /** Removes one integration; a no-op if it is already absent. */
  remove(id: string): void {
    const next = this.entries.filter((entry) => entry.id !== id);
    if (next.length !== this.entries.length) {
      this.entries = next;
      this.persist();
    }
  }

  /** Merges a partial change into one integration (e.g. its `enabled` flag); a no-op if absent. */
  update(id: string, patch: Partial<Omit<StoredIntegration, "id">>): void {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return;
    }
    this.entries[index] = { ...this.entries[index], ...patch };
    this.persist();
  }

  /** Loads the persisted list, tolerating an absent/corrupt file and skipping malformed entries. */
  private load(): StoredIntegration[] {
    let raw: string;
    try {
      raw = this.readFile(this.filePath);
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const list = (parsed as { integrations?: unknown })?.integrations;
    if (!Array.isArray(list)) {
      return [];
    }
    const entries: StoredIntegration[] = [];
    const seen = new Set<string>();
    for (const candidate of list) {
      const entry = parseEntry(candidate);
      if (entry !== null && !seen.has(entry.id)) {
        entries.push(entry);
        seen.add(entry.id);
      }
    }
    return entries;
  }

  /** Persists the list pretty-printed (a human-readable, hand-editable file), swallowing write errors. */
  private persist(): void {
    try {
      this.writeFile(this.filePath, `${JSON.stringify({ integrations: this.entries }, null, 2)}\n`);
    } catch (error) {
      console.error("[lune] could not persist integrations config:", error);
    }
  }
}

/** Validates one persisted entry, returning it typed or `null` when it is malformed. */
function parseEntry(candidate: unknown): StoredIntegration | null {
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
  if (id.length === 0 || displayName.length === 0) {
    return null;
  }
  const category = IntegrationCategorySchema.safeParse(record.category);
  const entry: StoredIntegration = {
    id,
    displayName,
    category: category.success ? category.data : "other",
    enabled: record.enabled === true,
  };
  if (typeof record.presetId === "string" && record.presetId.trim().length > 0) {
    entry.presetId = record.presetId.trim();
  }
  const transport = CustomTransportSchema.safeParse(record.customTransport);
  if (transport.success) {
    entry.customTransport = transport.data;
  }
  // A well-formed entry is either a preset instance or a custom server; one identifying half
  // must be present, else it cannot be connected and is dropped.
  if (entry.presetId === undefined && entry.customTransport === undefined) {
    return null;
  }
  return entry;
}
