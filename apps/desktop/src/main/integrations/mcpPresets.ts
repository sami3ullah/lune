import type { McpTransportConfig } from "@lune/core";
import type { CredentialField, IntegrationAuthKind, IntegrationCategory } from "../../ipc/integrations";

// The integrations preset catalog (M6-02): the curated, "one-click" flagship apps - Spotify,
// Obsidian, Google Sheets, Google Docs, Gmail - so a non-technical user adds real capability
// without hand-writing a server command or a URL (DECISIONS #16: MCP servers are how Lune
// grows tools). Each preset knows three things: how it authenticates (nothing, a couple of
// pasted values with step-by-step guidance, or a browser OAuth sign-in), which values it
// needs, and how to turn those values into the Core's transport-agnostic `McpServerConfig`
// transport. Secrets are passed into the built transport in-memory at connect time and never
// persisted (the on-disk config is secret-free); OAuth tokens are handled by the connector's
// auth provider, so an OAuth preset's transport is just its URL.
//
// This is Shell data (the exact npm package / hosted endpoint is a deployment detail, like
// `predefinedSkills.ts`), so the Core stays free of any app-specific knowledge. The package
// names and endpoints below are the canonical community/hosted MCP servers for each app as of
// authoring; they are the one place to update if an app's server moves.

/** How Lune reaches each flagship app's MCP server. Adjust here if a server package/URL moves. */
const OBSIDIAN_MCP_PACKAGE = "obsidian-mcp";
const SPOTIFY_MCP_PACKAGE = "spotify-mcp-server";

/**
 * The hosted, OAuth-protected Streamable-HTTP MCP endpoints for Google Workspace apps. These
 * are the integration's server URL (not a Google API URL); the connector's OAuth provider
 * drives the standard MCP authorization flow against whatever server answers here.
 *
 * IMPORTANT: the defaults below are placeholders - a Google integration cannot actually connect
 * until these point at a real deployed Google Workspace MCP gateway. Override each per
 * deployment with the matching `LUNE_MCP_*_URL` environment variable (e.g. in the packaged
 * app's launch environment) so the endpoint is a config value, not a code change. The OAuth
 * machinery itself is complete and provider-agnostic; only the endpoint is deployment-specific.
 */
const GOOGLE_SHEETS_MCP_URL = process.env.LUNE_MCP_GOOGLE_SHEETS_URL ?? "https://mcp.example.invalid/sheets";
const GOOGLE_DOCS_MCP_URL = process.env.LUNE_MCP_GOOGLE_DOCS_URL ?? "https://mcp.example.invalid/docs";
const GMAIL_MCP_URL = process.env.LUNE_MCP_GMAIL_URL ?? "https://mcp.example.invalid/gmail";

/**
 * One flagship integration the catalog offers. `credentialFields` is empty for `none`/`oauth`
 * presets that need no pasted values (an OAuth preset may still list fields when it needs, say,
 * a client id). `buildTransport` receives the resolved credential values (decrypted from the
 * secret store) and returns the Core transport, injecting any secrets into env/args.
 */
export interface McpPreset {
  id: string;
  displayName: string;
  description: string;
  category: IntegrationCategory;
  authKind: IntegrationAuthKind;
  credentialFields: readonly CredentialField[];
  /** A friendly one-liner about what adding this will involve (shown before the user commits). */
  setupHint?: string;
  /** Builds the Core transport from resolved (decrypted) credential values. */
  buildTransport: (values: Readonly<Record<string, string>>) => McpTransportConfig;
}

/** The flagship catalog, in display order. */
export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "spotify",
    displayName: "Spotify",
    description: "Play, pause, search, and queue music, and read your playlists and library.",
    category: "music",
    authKind: "credentials",
    setupHint: "Needs a free Spotify developer app (2 minutes) - Lune walks you through it.",
    credentialFields: [
      {
        key: "clientId",
        label: "Client ID",
        help: "Open the Spotify Developer Dashboard, click Create app (any name), then copy the app's Client ID here.",
        docsUrl: "https://developer.spotify.com/dashboard",
        placeholder: "e.g. 4a1b2c3d...",
        secret: false,
        required: true,
      },
      {
        key: "clientSecret",
        label: "Client secret",
        help: "On the same Spotify app page, click 'View client secret' and paste it here. Keep it private - Lune stores it encrypted.",
        docsUrl: "https://developer.spotify.com/dashboard",
        secret: true,
        required: true,
      },
    ],
    buildTransport: (values) => ({
      kind: "stdio",
      command: "npx",
      args: ["-y", SPOTIFY_MCP_PACKAGE],
      env: {
        SPOTIFY_CLIENT_ID: values.clientId ?? "",
        SPOTIFY_CLIENT_SECRET: values.clientSecret ?? "",
      },
    }),
  },
  {
    id: "obsidian",
    displayName: "Obsidian",
    description: "Read, search, and write notes in your Obsidian vault.",
    category: "notes",
    authKind: "credentials",
    setupHint: "Just point Lune at your vault folder - nothing to sign in to.",
    credentialFields: [
      {
        key: "vaultPath",
        label: "Vault folder",
        help: "The full path to your Obsidian vault folder, e.g. /Users/you/Documents/MyVault. In Obsidian, this is the folder you opened as a vault.",
        placeholder: "/Users/you/Documents/MyVault",
        secret: false,
        required: true,
      },
    ],
    buildTransport: (values) => ({
      kind: "stdio",
      command: "npx",
      args: ["-y", OBSIDIAN_MCP_PACKAGE, values.vaultPath ?? ""],
    }),
  },
  {
    id: "google-sheets",
    displayName: "Google Sheets",
    description: "Create spreadsheets and read, append, and update rows and cells.",
    category: "productivity",
    authKind: "oauth",
    setupHint: "One-click sign-in with Google - a browser window asks you to allow access.",
    credentialFields: [],
    buildTransport: () => ({ kind: "http", url: GOOGLE_SHEETS_MCP_URL }),
  },
  {
    id: "google-docs",
    displayName: "Google Docs",
    description: "Create and edit documents, and read their contents.",
    category: "productivity",
    authKind: "oauth",
    setupHint: "One-click sign-in with Google - a browser window asks you to allow access.",
    credentialFields: [],
    buildTransport: () => ({ kind: "http", url: GOOGLE_DOCS_MCP_URL }),
  },
  {
    id: "gmail",
    displayName: "Gmail",
    description: "Search, read, draft, and send email from your Gmail account.",
    category: "email",
    authKind: "oauth",
    setupHint: "One-click sign-in with Google - a browser window asks you to allow access.",
    credentialFields: [],
    buildTransport: () => ({ kind: "http", url: GMAIL_MCP_URL }),
  },
];

/** The preset with this id, or `undefined`. */
export function findPreset(
  presetId: string,
  presets: readonly McpPreset[] = MCP_PRESETS,
): McpPreset | undefined {
  return presets.find((preset) => preset.id === presetId);
}
