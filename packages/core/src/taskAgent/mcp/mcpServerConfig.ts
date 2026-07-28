/**
 * MCP server configuration (M6-01): how one external MCP server is described to the Core.
 *
 * A configured server is the unit the {@link import("./mcpServerManager.js").McpServerManager}
 * connects, enables/disables, and reports the health of. The Core owns this shape - a stable,
 * transport-independent description - but never acts on the transport details itself: the
 * injected {@link import("./mcpConnection.js").McpConnector} (the Shell's, using the real MCP
 * SDK) is what interprets `transport` and opens the connection. That keeps the Core pure and
 * transport-agnostic (developer story 45), exactly like the local tool set's platform seam.
 *
 * Where these configs live and how they are edited is the Shell's concern (M6-02: the
 * Settings integrations surface, with OAuth tokens in OS-encrypted storage, never in a config
 * file). The Core is handed a config set and reflects it.
 */

/**
 * How to reach one MCP server. A discriminated union so the injected connector can switch on
 * `kind` and the Core can carry either shape opaquely:
 *
 *   - `stdio` - a local child process the connector spawns (`command` + `args`), the common
 *     shape for locally-installed servers (Obsidian, a filesystem server).
 *   - `http` - a remote server reached over Streamable HTTP, with optional `headers` for the
 *     bearer token an OAuth flow (M6-02) produces. Tokens are passed at connect time from
 *     encrypted storage; they are never persisted in this config on disk.
 */
export type McpTransportConfig =
  | {
      kind: "stdio";
      /** The executable to spawn (e.g. `npx`, or an absolute path to a server binary). */
      command: string;
      /** The arguments passed to `command` (e.g. `["-y", "@some/mcp-server"]`). */
      args?: readonly string[];
      /** Extra environment variables for the child process (secrets injected at launch). */
      env?: Readonly<Record<string, string>>;
    }
  | {
      kind: "http";
      /** The server's Streamable HTTP endpoint URL. */
      url: string;
      /** Request headers, e.g. `{ Authorization: "Bearer ..." }` from the OAuth flow. */
      headers?: Readonly<Record<string, string>>;
    };

/** One configured MCP server the manager may connect. */
export interface McpServerConfig {
  /**
   * A stable, unique identifier for the server, safe to embed in a tool name
   * (`[A-Za-z0-9_-]`, e.g. `spotify`, `google-sheets`). Used to namespace the server's tools
   * so two servers exposing a same-named tool never collide in the shared registry.
   */
  id: string;
  /** A human label for the server, shown in Settings and spoken by the Confirm Gate. */
  displayName: string;
  /** Whether the manager should connect this server; a disabled server contributes no tools. */
  enabled: boolean;
  /** How to reach the server; interpreted only by the injected connector, never by the Core. */
  transport: McpTransportConfig;
}
