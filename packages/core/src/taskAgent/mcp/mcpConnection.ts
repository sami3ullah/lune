/**
 * The MCP connection seam (M6-01): the single injected boundary through which the Core
 * speaks the Model Context Protocol, so the Core stays pure and transport-agnostic - it
 * imports no MCP SDK, no child_process, no HTTP (developer story 45). It is the MCP analogue
 * of the local tool set's {@link import("../localToolPlatform.js").LocalToolPlatform}: the
 * Core owns the client *logic* (lifecycle, tool discovery, schema translation, consequence
 * gating, registry composition) and calls through this seam for the transport.
 *
 * The Electron main process fills this with the real MCP SDK client over a stdio child
 * process or a Streamable HTTP transport; a test fills it with a fake that returns canned
 * tools and results. Either way the Core only ever `connect`s a server, `listTools`, and
 * `callTool` - the JSON-RPC framing, the `initialize` handshake, process spawning, and
 * reconnection transport all live behind the connector.
 */
import type { ToolParameterSchema } from "../toolTypes.js";
import type { McpServerConfig } from "./mcpServerConfig.js";

/**
 * The behavioural hints an MCP tool declares about itself (the protocol's tool annotations).
 * They are advisory and server-supplied, so the Core treats them conservatively: only a clear
 * `readOnlyHint` earns a tool `benign`; everything else stays `consequential` and gated (see
 * {@link import("./mcpToolConsequence.js").classifyMcpTool}). All optional - a server that
 * omits them leaves every tool gated, which is the safe default.
 */
export interface McpToolAnnotations {
  /** A human-friendly title for the tool (preferred over `name` for display). */
  title?: string;
  /** True if the tool does not modify its environment - the one hint that earns `benign`. */
  readOnlyHint?: boolean;
  /** True if the tool may perform destructive updates (delete/overwrite) when not read-only. */
  destructiveHint?: boolean;
  /** True if repeated identical calls have no additional effect. */
  idempotentHint?: boolean;
  /** True if the tool interacts with an open, external world (the web, a third-party API). */
  openWorldHint?: boolean;
}

/** One tool a server advertises, as returned by the MCP `tools/list` call. */
export interface McpToolDefinition {
  /** The tool's name within its server (namespaced by the Core before the model sees it). */
  name: string;
  /** The server's natural-language description of the tool (may be absent). */
  description?: string;
  /**
   * The JSON-Schema of the tool's arguments (MCP's `inputSchema`), passed to the model
   * verbatim. Always an object schema per the protocol; the Core defensively normalises a
   * missing/odd schema to an empty object schema.
   */
  inputSchema?: ToolParameterSchema;
  /** The tool's behavioural hints, used for consequence classification. */
  annotations?: McpToolAnnotations;
}

/**
 * One block of an MCP tool-call result's content. The Core flattens these into the single
 * text `output` a {@link import("../toolTypes.js").ToolExecutionResult} carries, and surfaces
 * an http(s) resource as an openable artifact (so a "created the sheet" result can be opened
 * from its Agent Stack card). Kinds beyond these are summarised as a short placeholder.
 */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: string; [key: string]: unknown };

/** The result of one MCP `tools/call`, as the connector surfaces it. */
export interface McpToolCallResult {
  /** The call's content blocks, flattened by the Core into the model-facing output text. */
  content: readonly McpContentBlock[];
  /**
   * True when the tool reported a recoverable error (MCP's `isError`); the Core passes it
   * through as a recoverable tool result the model sees and can adapt to - it never fails the
   * Session.
   */
  isError?: boolean;
}

/**
 * A live connection to one MCP server. The connector returns this once the transport is up
 * and the MCP `initialize` handshake has completed; the manager then discovers and calls
 * tools through it, and `close`s it on disable/shutdown.
 */
export interface McpServerConnection {
  /** Lists the server's tools (MCP `tools/list`). Rejects if the server is unreachable. */
  listTools(signal?: AbortSignal): Promise<readonly McpToolDefinition[]>;
  /**
   * Calls one tool by its server-local name (MCP `tools/call`). A tool that runs but reports
   * a problem resolves with `isError: true` (recoverable); an unreachable server rejects.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult>;
  /**
   * Registers a listener for the connection closing *unexpectedly* - the server process
   * exited, the HTTP session dropped. The manager uses it to mark a ready server errored so
   * its tools vanish promptly (the health half of the epic's "server failures degrade
   * gracefully"), rather than waiting for the next call to fail. A deliberate {@link close}
   * may also invoke it; the manager guards against that. Optional so a minimal fake need not
   * implement it - a connection that never reports closure just relies on call-time errors.
   */
  onClose?(listener: (reason?: string) => void): void;
  /** Closes the transport (terminates the child process / HTTP session). Idempotent. */
  close(): Promise<void>;
}

/**
 * Opens a connection to a configured MCP server, completing the transport setup and the MCP
 * `initialize` handshake before resolving. Rejects when the server cannot be reached or the
 * handshake fails - which the manager turns into a clean `error` status, its tools absent,
 * without disturbing any other server. Injected by the Shell; tests pass a fake.
 */
export type McpConnector = (
  config: McpServerConfig,
  signal?: AbortSignal,
) => Promise<McpServerConnection>;
