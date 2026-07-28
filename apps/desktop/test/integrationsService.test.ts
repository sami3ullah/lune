import { describe, expect, it, beforeEach } from "vitest";

import type { McpServerConfig, McpServerManager, McpServerState } from "@lune/core";
import type { IntegrationActionResult } from "../src/ipc/integrations";
import { IntegrationsService } from "../src/main/integrations/integrationsService";
import { McpConfigStore } from "../src/main/integrations/mcpConfigStore";
import { McpSecretStore } from "../src/main/integrations/mcpSecretStore";
import type { McpPreset } from "../src/main/integrations/mcpPresets";
import type { McpOAuthCoordinator } from "../src/main/integrations/mcpOAuth";
import type { SecureEncryptor } from "../src/main/settings/credentialStore";

// The integrations service is where M6-02's acceptances are proved end to end against fakes:
// adding a preset then authenticating makes its tools usable; tokens/credentials go to the
// encrypted store and removal cleans them up fully; and an app's status reflects
// disabled / needs-auth / connected. The Core manager, the OAuth coordinator, and the OS
// keychain are faked; the config + secret stores are real (over in-memory files).

const testPresets: McpPreset[] = [
  {
    id: "echo",
    displayName: "Echo",
    description: "A no-auth server.",
    category: "developer",
    authKind: "none",
    credentialFields: [],
    buildTransport: () => ({ kind: "stdio", command: "echo" }),
  },
  {
    id: "notes",
    displayName: "Notes",
    description: "A credentials server.",
    category: "notes",
    authKind: "credentials",
    credentialFields: [
      { key: "path", label: "Path", help: "the vault path", secret: false, required: true },
    ],
    buildTransport: (values) => ({ kind: "stdio", command: "notes", args: [values.path ?? ""] }),
  },
  {
    id: "sheets",
    displayName: "Sheets",
    description: "An OAuth server.",
    category: "productivity",
    authKind: "oauth",
    credentialFields: [],
    buildTransport: () => ({ kind: "http", url: "https://sheets.example/mcp" }),
  },
];

function fakeEncryptor(): SecureEncryptor {
  const PREFIX = "enc::";
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(PREFIX + plain, "utf8"),
    decryptString: (buf) => {
      const text = buf.toString("utf8");
      if (!text.startsWith(PREFIX)) throw new Error("bad");
      return text.slice(PREFIX.length);
    },
  };
}

function inMemoryFs() {
  const files = new Map<string, string>();
  return {
    files,
    read: (path: string): string => {
      const c = files.get(path);
      if (c === undefined) throw new Error("ENOENT");
      return c;
    },
    write: (path: string, contents: string): void => {
      files.set(path, contents);
    },
  };
}

/** A fake manager: it reports every configured server as `ready` with one tool. */
function fakeManager() {
  let configured: McpServerConfig[] = [];
  const listeners = new Set<() => void>();
  const manager: McpServerManager & { configureCalls: McpServerConfig[][]; refreshed: string[] } = {
    configureCalls: [],
    refreshed: [],
    async start() {},
    listTools() {
      return [];
    },
    states(): McpServerState[] {
      return configured.map((c) => ({
        id: c.id,
        displayName: c.displayName,
        status: "ready",
        toolCount: 1,
        tools: [{ name: `mcp_${c.id}_x`, label: "x" }],
        error: undefined,
      }));
    },
    async setEnabled() {},
    async refresh(id: string) {
      manager.refreshed.push(id);
    },
    async configure(next) {
      configured = [...next];
      manager.configureCalls.push([...next]);
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {},
  };
  return manager;
}

/** A fake OAuth coordinator with a settable authorize outcome and an in-memory token set. */
function fakeOAuth() {
  const tokens = new Set<string>();
  const coordinator: McpOAuthCoordinator & {
    registered: string[];
    forgot: string[];
    authorizeResult: IntegrationActionResult;
    grant: (id: string) => void;
  } = {
    registered: [],
    forgot: [],
    authorizeResult: { ok: true },
    grant: (id) => tokens.add(id),
    register(id) {
      coordinator.registered.push(id);
    },
    hasTokens(id) {
      return tokens.has(id);
    },
    async authorize(id) {
      if (coordinator.authorizeResult.ok) tokens.add(id);
      return coordinator.authorizeResult;
    },
    forget(id) {
      tokens.delete(id);
      coordinator.forgot.push(id);
    },
  };
  return coordinator;
}

function build() {
  const cfgFs = inMemoryFs();
  const secretFs = inMemoryFs();
  const configStore = new McpConfigStore("/integrations.json", cfgFs.read, cfgFs.write);
  const secretStore = new McpSecretStore("/secrets.json", fakeEncryptor(), secretFs.read, secretFs.write);
  const manager = fakeManager();
  const oauth = fakeOAuth();
  let changes = 0;
  const service = new IntegrationsService({
    manager,
    configStore,
    secretStore,
    oauth,
    presets: testPresets,
    onChanged: () => {
      changes += 1;
    },
  });
  return { service, manager, oauth, configStore, secretStore, secretFs, changes: () => changes };
}

function view(service: IntegrationsService, id: string) {
  return service.snapshot().integrations.find((i) => i.id === id);
}

describe("IntegrationsService", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it("adds a no-auth preset and connects it immediately, marking the preset as added", async () => {
    await ctx.service.add({ source: "preset", presetId: "echo" });

    expect(view(ctx.service, "echo")).toMatchObject({ status: "ready", enabled: true, toolCount: 1 });
    // The catalog shows it as added, so it is not offered again.
    expect(ctx.service.snapshot().presets.find((p) => p.id === "echo")?.added).toBe(true);
    // It was handed to the manager.
    expect(ctx.manager.configureCalls.at(-1)?.map((c) => c.id)).toContain("echo");
  });

  it("holds a credentials preset in needs-details until required values are provided, then connects", async () => {
    await ctx.service.add({ source: "preset", presetId: "notes" });
    expect(view(ctx.service, "notes")).toMatchObject({ status: "auth-expired", authorized: false });
    // Not handed to the manager while unauthorized.
    expect(ctx.manager.configureCalls.at(-1)?.map((c) => c.id)).not.toContain("notes");

    await ctx.service.setCredentials("notes", { path: "/Users/me/Vault" });

    const v = view(ctx.service, "notes");
    expect(v).toMatchObject({ status: "ready", authorized: true, providedCredentialKeys: ["path"] });
    // The value reached the manager's resolved transport (injected as the command arg).
    const notesConfig = ctx.manager.configureCalls.at(-1)?.find((c) => c.id === "notes");
    expect(notesConfig?.transport).toMatchObject({ kind: "stdio", args: ["/Users/me/Vault"] });
  });

  it("stores credentials only in the encrypted secret store, never plaintext", async () => {
    await ctx.service.add({ source: "preset", presetId: "notes" });
    await ctx.service.setCredentials("notes", { path: "/secret/path" });
    // The persisted secret file exists and holds ciphertext, not the raw value.
    const secretFile = ctx.secretFs.files.get("/secrets.json");
    expect(secretFile).toBeDefined();
    expect(secretFile).not.toContain("/secret/path");
  });

  it("requires OAuth sign-in, then connects after a successful authorize", async () => {
    await ctx.service.add({ source: "preset", presetId: "sheets" });
    expect(view(ctx.service, "sheets")).toMatchObject({ status: "auth-expired", authKind: "oauth" });

    const { result } = await ctx.service.startAuth("sheets");

    expect(result.ok).toBe(true);
    expect(ctx.oauth.registered).toContain("sheets");
    expect(view(ctx.service, "sheets")).toMatchObject({ status: "ready", authorized: true });
    expect(ctx.manager.refreshed).toContain("sheets");
  });

  it("reports the reason and stays unconnected when OAuth sign-in fails", async () => {
    await ctx.service.add({ source: "preset", presetId: "sheets" });
    ctx.oauth.authorizeResult = { ok: false, reason: "User cancelled." };

    const { result } = await ctx.service.startAuth("sheets");

    expect(result).toEqual({ ok: false, reason: "User cancelled." });
    expect(view(ctx.service, "sheets")).toMatchObject({ status: "auth-expired", authorized: false });
  });

  it("removes an integration fully: config gone, secrets cleared, dropped from the manager", async () => {
    await ctx.service.add({ source: "preset", presetId: "notes" });
    await ctx.service.setCredentials("notes", { path: "/p" });
    expect(ctx.secretStore.has("notes::cred::path")).toBe(true);

    await ctx.service.remove("notes");

    expect(view(ctx.service, "notes")).toBeUndefined();
    expect(ctx.configStore.has("notes")).toBe(false);
    expect(ctx.secretStore.has("notes::cred::path")).toBe(false);
    expect(ctx.oauth.forgot).toContain("notes");
    expect(ctx.manager.configureCalls.at(-1)?.map((c) => c.id)).not.toContain("notes");
  });

  it("disabling keeps the integration but removes it from the connected set", async () => {
    await ctx.service.add({ source: "preset", presetId: "echo" });
    await ctx.service.setEnabled("echo", false);

    expect(view(ctx.service, "echo")).toMatchObject({ status: "disabled", enabled: false });
    expect(ctx.manager.configureCalls.at(-1)?.map((c) => c.id)).not.toContain("echo");
  });

  it("adds a custom server with its own transport and connects it", async () => {
    await ctx.service.add({
      source: "custom",
      displayName: "My Server",
      transport: { kind: "stdio", command: "my-mcp", args: ["--go"] },
    });
    const v = view(ctx.service, "custom-my-server");
    expect(v).toMatchObject({ status: "ready", authKind: "none" });
    const cfg = ctx.manager.configureCalls.at(-1)?.find((c) => c.id === "custom-my-server");
    expect(cfg?.transport).toMatchObject({ kind: "stdio", command: "my-mcp" });
  });

  it("reconnects the enabled + authorized set on start()", async () => {
    // Pre-seed the config store as if from a previous run, then start a fresh service.
    ctx.configStore.add({ id: "echo", presetId: "echo", displayName: "Echo", category: "developer", enabled: true });
    const manager = fakeManager();
    const service = new IntegrationsService({
      manager,
      configStore: ctx.configStore,
      secretStore: ctx.secretStore,
      oauth: ctx.oauth,
      presets: testPresets,
    });
    await service.start();
    expect(manager.configureCalls.at(-1)?.map((c) => c.id)).toEqual(["echo"]);
  });
});
