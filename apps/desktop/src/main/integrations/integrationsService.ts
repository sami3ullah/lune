import type { McpServerConfig, McpServerManager } from "@lune/core";
import type {
  AddIntegrationRequest,
  Integration,
  IntegrationActionResponse,
  IntegrationPreset,
  IntegrationStatus,
  IntegrationsSnapshot,
} from "../../ipc/integrations";
import { McpConfigStore, type StoredIntegration } from "./mcpConfigStore";
import { MCP_PRESETS, findPreset, type McpPreset } from "./mcpPresets";
import type { McpOAuthCoordinator } from "./mcpOAuth";
import type { McpSecretStore } from "./mcpSecretStore";

// The integrations service (M6-02): the Shell's brain for the Integrations surface, composing
// the preset catalog, the secret-free config store, the OS-encrypted secret store, and the
// OAuth coordinator into the operations the tab calls - and reconciling all of that into the
// live server set the Core's `McpServerManager` (M6-01) actually connects. It is the
// integrations analogue of `SettingsService`.
//
// The invariant it enforces is the acceptance set: a server is only handed to the manager when
// it is both turned on AND has what it needs to authenticate (required credentials present, or
// an OAuth token stored), so an unconfigured app never spams connection errors - it simply
// reads as "needs sign-in / needs details". Secrets are injected into the resolved transport
// in memory at connect time and never persisted; removing an integration drops its config,
// every stored secret, and its OAuth tokens, then reconciles the manager so its tools vanish.

/** The injected pieces the service is built from. */
export interface IntegrationsServiceDependencies {
  /** The Core MCP manager whose connected set this service reconciles. */
  manager: McpServerManager;
  /** The persisted, secret-free list of added integrations. */
  configStore: McpConfigStore;
  /** The OS-encrypted store for credential values and OAuth tokens. */
  secretStore: McpSecretStore;
  /** The OAuth "Connect" coordinator (also the provider registry the connector consults). */
  oauth: McpOAuthCoordinator;
  /** The catalog; defaults to the flagship {@link MCP_PRESETS} (overridable for tests). */
  presets?: readonly McpPreset[];
  /** Fired after any change (and on every manager state change) so the tab re-renders. */
  onChanged?: () => void;
}

/** The secret-store key one guided credential value lives under. */
function credentialKey(integrationId: string, fieldKey: string): string {
  return `${integrationId}::cred::${fieldKey}`;
}

/** The prefix covering every stored secret (creds + OAuth) of one integration. */
function secretPrefix(integrationId: string): string {
  return `${integrationId}::`;
}

export class IntegrationsService {
  private readonly manager: McpServerManager;
  private readonly configStore: McpConfigStore;
  private readonly secretStore: McpSecretStore;
  private readonly oauth: McpOAuthCoordinator;
  private readonly presets: readonly McpPreset[];
  private readonly onChanged: () => void;

  constructor(dependencies: IntegrationsServiceDependencies) {
    this.manager = dependencies.manager;
    this.configStore = dependencies.configStore;
    this.secretStore = dependencies.secretStore;
    this.oauth = dependencies.oauth;
    this.presets = dependencies.presets ?? MCP_PRESETS;
    this.onChanged = dependencies.onChanged ?? (() => {});
    // A live manager state change (connecting -> ready, an unexpected drop) refreshes the tab.
    this.manager.subscribe(() => this.onChanged());
  }

  /**
   * Reconciles the manager with the stored config on startup: registers OAuth servers so the
   * connector can attach their providers, then connects every enabled + authorized server.
   * Called once after construction (the manager starts empty).
   */
  async start(): Promise<void> {
    await this.reconcile();
  }

  /** The tab's whole state: the addable catalog and the user's configured integrations. */
  snapshot(): IntegrationsSnapshot {
    return {
      presets: this.presets.map((preset) => this.toPresetView(preset)),
      integrations: this.configStore.all().map((stored) => this.toIntegrationView(stored)),
    };
  }

  /** Adds an integration (from a preset, or a custom server), then connects it if it is ready. */
  async add(request: AddIntegrationRequest): Promise<IntegrationsSnapshot> {
    if (request.source === "preset") {
      const preset = findPreset(request.presetId, this.presets);
      if (preset !== undefined && !this.configStore.has(preset.id)) {
        this.configStore.add({
          id: preset.id,
          presetId: preset.id,
          displayName: preset.displayName,
          category: preset.category,
          enabled: true,
        });
      }
    } else {
      const id = this.mintCustomId(request.displayName);
      this.configStore.add({
        id,
        displayName: request.displayName,
        category: "other",
        enabled: true,
        customTransport: request.transport,
      });
    }
    await this.reconcile();
    return this.changed();
  }

  /** Removes an integration entirely: its config, every stored secret, and its OAuth tokens. */
  async remove(id: string): Promise<IntegrationsSnapshot> {
    this.configStore.remove(id);
    this.secretStore.removeByPrefix(secretPrefix(id));
    this.oauth.forget(id);
    await this.reconcile();
    return this.changed();
  }

  /** Turns one integration on or off (connect / disconnect). */
  async setEnabled(id: string, enabled: boolean): Promise<IntegrationsSnapshot> {
    this.configStore.update(id, { enabled });
    await this.reconcile();
    return this.changed();
  }

  /** Re-attempts one integration's connection (the retry after an error). */
  async refresh(id: string): Promise<IntegrationsSnapshot> {
    await this.reconcile();
    const stored = this.configStore.get(id);
    if (stored !== undefined && this.isConnectable(stored)) {
      await this.manager.refresh(id);
    }
    return this.changed();
  }

  /**
   * Saves (or clears) one integration's guided credential values into encrypted storage, then
   * reconciles - so providing the last required value connects the app on the spot.
   */
  async setCredentials(id: string, values: Record<string, string>): Promise<IntegrationsSnapshot> {
    for (const [fieldKey, value] of Object.entries(values)) {
      this.secretStore.set(credentialKey(id, fieldKey), value);
    }
    await this.reconcile();
    return this.changed();
  }

  /**
   * Begins (or renews) an OAuth integration's browser sign-in. On success the token is stored
   * and the app connects; on failure the reason is returned for the tab to explain.
   */
  async startAuth(id: string): Promise<IntegrationActionResponse> {
    const stored = this.configStore.get(id);
    const preset = stored?.presetId !== undefined ? findPreset(stored.presetId, this.presets) : undefined;
    if (stored === undefined || preset === undefined || preset.authKind !== "oauth") {
      return { result: { ok: false, reason: "This integration does not use sign-in." }, snapshot: this.snapshot() };
    }
    // Make sure the coordinator knows where to sign in (reconcile registers too, but a
    // never-connected server may not have been reconciled with a URL yet).
    const serverUrl = this.oauthServerUrl(preset);
    if (serverUrl !== undefined) {
      this.oauth.register(id, serverUrl);
    }
    const result = await this.oauth.authorize(id);
    await this.reconcile();
    if (result.ok && this.isConnectable(stored)) {
      // Force a reconnect so the freshly-stored token is used even when the config is unchanged
      // (a renewal of an already-connected OAuth server): reconcile alone would see no config
      // change and leave the stale connection in place.
      await this.manager.refresh(id);
    }
    return { result, snapshot: this.changed() };
  }

  // --- internals -------------------------------------------------------------------------

  /** Fires the change callback and returns the fresh snapshot (the reply every mutation sends). */
  private changed(): IntegrationsSnapshot {
    this.onChanged();
    return this.snapshot();
  }

  /**
   * Rebuilds the manager's connected set from the stored config: registers every OAuth server
   * (so the connector attaches its provider), then hands the manager exactly the servers that
   * are enabled AND authorized, with secrets injected into their resolved transports.
   */
  private async reconcile(): Promise<void> {
    const configs: McpServerConfig[] = [];
    for (const stored of this.configStore.all()) {
      const preset = stored.presetId !== undefined ? findPreset(stored.presetId, this.presets) : undefined;
      if (preset?.authKind === "oauth") {
        const serverUrl = this.oauthServerUrl(preset);
        if (serverUrl !== undefined) {
          this.oauth.register(stored.id, serverUrl);
        }
      }
      if (this.isConnectable(stored, preset)) {
        configs.push(this.buildResolvedConfig(stored, preset));
      }
    }
    await this.manager.configure(configs);
  }

  /** Whether a stored integration is both turned on and has what it needs to authenticate. */
  private isConnectable(stored: StoredIntegration, preset = this.presetFor(stored)): boolean {
    return stored.enabled && this.isAuthorized(stored, preset);
  }

  /** Whether an integration currently has its required credentials / OAuth token. */
  private isAuthorized(stored: StoredIntegration, preset = this.presetFor(stored)): boolean {
    if (preset === undefined) {
      return true; // A custom server carries its own (secret-free) transport.
    }
    if (preset.authKind === "oauth") {
      return this.oauth.hasTokens(stored.id);
    }
    if (preset.authKind === "credentials") {
      return preset.credentialFields
        .filter((field) => field.required)
        .every((field) => this.secretStore.has(credentialKey(stored.id, field.key)));
    }
    return true; // authKind "none"
  }

  /** Builds the fully-resolved (secrets injected) Core config the manager connects. */
  private buildResolvedConfig(stored: StoredIntegration, preset = this.presetFor(stored)): McpServerConfig {
    const transport =
      preset !== undefined
        ? preset.buildTransport(this.resolveCredentialValues(stored, preset))
        : stored.customTransport!;
    return { id: stored.id, displayName: stored.displayName, enabled: true, transport };
  }

  /** The decrypted values for one preset's credential fields, keyed by field key. */
  private resolveCredentialValues(stored: StoredIntegration, preset: McpPreset): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of preset.credentialFields) {
      const value = this.secretStore.get(credentialKey(stored.id, field.key));
      if (value !== undefined) {
        values[field.key] = value;
      }
    }
    return values;
  }

  private presetFor(stored: StoredIntegration): McpPreset | undefined {
    return stored.presetId !== undefined ? findPreset(stored.presetId, this.presets) : undefined;
  }

  /** The OAuth server URL a preset connects to (its bare HTTP transport url), if any. */
  private oauthServerUrl(preset: McpPreset): string | undefined {
    const transport = preset.buildTransport({});
    return transport.kind === "http" ? transport.url : undefined;
  }

  private toPresetView(preset: McpPreset): IntegrationPreset {
    return {
      id: preset.id,
      displayName: preset.displayName,
      description: preset.description,
      category: preset.category,
      authKind: preset.authKind,
      credentialFields: [...preset.credentialFields],
      setupHint: preset.setupHint,
      added: this.configStore.has(preset.id),
    };
  }

  private toIntegrationView(stored: StoredIntegration): Integration {
    const preset = this.presetFor(stored);
    const authKind = preset?.authKind ?? "none";
    const credentialFields = preset !== undefined ? [...preset.credentialFields] : [];
    const authorized = this.isAuthorized(stored, preset);
    const providedCredentialKeys = credentialFields
      .filter((field) => this.secretStore.has(credentialKey(stored.id, field.key)))
      .map((field) => field.key);

    const { status, tools, toolCount, error } = this.resolveHealth(stored, preset, authorized);

    return {
      id: stored.id,
      presetId: stored.presetId,
      displayName: stored.displayName,
      description: preset?.description ?? "A custom MCP server you added.",
      category: stored.category,
      enabled: stored.enabled,
      status,
      toolCount,
      tools,
      error,
      authKind,
      authorized,
      credentialFields,
      providedCredentialKeys,
    };
  }

  /**
   * The display health of one integration. A turned-off app reads `disabled`; an on-but-not-yet
   * authorized app reads `auth-expired` with a plain explanation (the "needs sign-in / needs
   * details" bucket the acceptance calls out); an on-and-authorized app reflects the manager's
   * live status and tools verbatim.
   */
  private resolveHealth(
    stored: StoredIntegration,
    preset: McpPreset | undefined,
    authorized: boolean,
  ): { status: IntegrationStatus; tools: Integration["tools"]; toolCount: number; error?: string } {
    if (!stored.enabled) {
      return { status: "disabled", tools: [], toolCount: 0 };
    }
    if (!authorized) {
      const reason =
        preset?.authKind === "oauth"
          ? "Sign in to connect this app."
          : "Add the required details to connect.";
      return { status: "auth-expired", tools: [], toolCount: 0, error: reason };
    }
    const state = this.manager.states().find((candidate) => candidate.id === stored.id);
    if (state === undefined) {
      return { status: "connecting", tools: [], toolCount: 0 };
    }
    return {
      status: state.status,
      tools: state.tools.map((tool) => ({ name: tool.name, label: tool.label })),
      toolCount: state.toolCount,
      error: state.error,
    };
  }

  /** A unique `custom-<slug>` id for a hand-added server, uniquified against existing ids. */
  private mintCustomId(displayName: string): string {
    const slug =
      displayName
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "server";
    const base = `custom-${slug}`;
    if (!this.configStore.has(base)) {
      return base;
    }
    let suffix = 2;
    while (this.configStore.has(`${base}-${suffix}`)) {
      suffix += 1;
    }
    return `${base}-${suffix}`;
  }
}
