import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpConnector,
  McpServerConfig,
  McpServerConnection,
  McpToolCallResult,
  McpToolDefinition,
} from "@lune/core";

// The Shell's real MCP transport (M6-01), filling the Core's transport-agnostic
// `McpConnector` seam with the official Model Context Protocol SDK client - the MCP analogue
// of `createNodeLocalToolPlatform` filling the local-tool platform seam. The Core owns the
// client *logic* (lifecycle, discovery, translation, consequence gating); this owns only the
// transport: spawning a stdio server child process or opening a Streamable HTTP session,
// running the `initialize` handshake, and adapting the SDK's `listTools`/`callTool`/`close`
// onto the Core's `McpServerConnection`. It is the one place the MCP SDK is imported, so a
// transport change (a new SDK, WebSocket) never reaches the Core.

/** The client identity Lune presents to a server during the MCP handshake. */
const CLIENT_INFO = { name: "lune", version: "0.0.0" } as const;

/**
 * Builds the Node MCP connector. Each `connect` opens a fresh SDK client over the transport
 * the config describes and resolves once the handshake completes; a spawn/connect/handshake
 * failure rejects, which the manager turns into a clean `error` status (its tools absent)
 * without disturbing any other server.
 */
export function createNodeMcpConnector(): McpConnector {
  return async (config: McpServerConfig): Promise<McpServerConnection> => {
    const client = new Client(CLIENT_INFO);
    const transport = createTransport(config);
    // Forward an unexpected transport close to the manager (registered via onClose below), so
    // a server that dies after connecting has its tools dropped rather than lingering.
    let closeListener: ((reason?: string) => void) | undefined;
    client.onclose = () => closeListener?.();
    await client.connect(transport);
    return {
      async listTools(signal) {
        const response = await client.listTools({}, { signal });
        return response.tools.map(toToolDefinition);
      },
      async callTool(name, args, signal) {
        const response = await client.callTool({ name, arguments: args }, undefined, { signal });
        return {
          content: (response.content ?? []) as readonly McpToolCallResult["content"][number][],
          isError: response.isError === true,
        };
      },
      onClose(listener) {
        closeListener = listener;
      },
      async close() {
        await client.close();
      },
    };
  };
}

/** Creates the SDK transport for a config's `transport` descriptor. */
function createTransport(config: McpServerConfig): Transport {
  const { transport } = config;
  if (transport.kind === "stdio") {
    return new StdioClientTransport({
      command: transport.command,
      args: transport.args ? [...transport.args] : undefined,
      // Merge the caller's env over the SDK's safe default (PATH, HOME, ...), so a server
      // that needs a secret in its environment still inherits a usable base environment.
      env: transport.env ? { ...getDefaultEnvironment(), ...transport.env } : undefined,
    });
  }
  return new StreamableHTTPClientTransport(new URL(transport.url), {
    requestInit: transport.headers ? { headers: { ...transport.headers } } : undefined,
  });
}

/** Adapts one SDK tool descriptor onto the Core's {@link McpToolDefinition}. */
function toToolDefinition(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolDefinition["annotations"];
}): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as McpToolDefinition["inputSchema"],
    annotations: tool.annotations,
  };
}
