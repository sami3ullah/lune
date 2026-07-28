import { describe, expect, it, vi } from "vitest";

import { createMcpServerManager } from "../src/taskAgent/mcp/mcpServerManager.js";
import type {
  McpConnector,
  McpServerConnection,
  McpToolDefinition,
} from "../src/taskAgent/mcp/mcpConnection.js";
import type { McpServerConfig } from "../src/taskAgent/mcp/mcpServerConfig.js";
import type { ToolConfirmGate } from "../src/taskAgent/toolConfirm.js";

// The manager owns MCP server lifecycle and is where the three M6-01 acceptances are proved:
// a configured server's tools appear and are callable; a failing server degrades gracefully
// (its tools vanish, no exception, others untouched); and consequential third-party calls
// trip the injected Confirm Gate. Driven with fake connections - no transport, no SDK.

const alwaysApprove: ToolConfirmGate = async () => true;

function config(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    displayName: overrides.displayName ?? id,
    enabled: overrides.enabled ?? true,
    transport: overrides.transport ?? { kind: "stdio", command: "server" },
  };
}

interface FakeConnectionOptions {
  tools?: readonly McpToolDefinition[];
  onCall?: (name: string, args: Record<string, unknown>) => void;
  /** Captures the close listener the manager registers, so a test can fire an unexpected drop. */
  captureClose?: (fire: (reason?: string) => void) => void;
}

function fakeConnection(options: FakeConnectionOptions = {}): McpServerConnection & { closed: boolean } {
  return {
    closed: false,
    async listTools() {
      return options.tools ?? [];
    },
    async callTool(name, args) {
      options.onCall?.(name, args);
      return { content: [{ type: "text", text: "ok" }] };
    },
    onClose(listener) {
      options.captureClose?.(listener);
    },
    async close() {
      (this as { closed: boolean }).closed = true;
    },
  };
}

describe("createMcpServerManager", () => {
  it("connects a configured server and exposes its tools, callable through the connection", async () => {
    const calls: string[] = [];
    const connector: McpConnector = async () =>
      fakeConnection({
        tools: [{ name: "get_sheet", annotations: { readOnlyHint: true } }],
        onCall: (name) => calls.push(name),
      });
    const manager = createMcpServerManager({ connector, confirm: alwaysApprove, servers: [config("sheets")] });

    await manager.start();

    expect(manager.states()).toEqual([
      { id: "sheets", displayName: "sheets", status: "ready", toolCount: 1, error: undefined },
    ]);
    const tools = manager.listTools();
    expect(tools.map((t) => t.name)).toEqual(["mcp_sheets_get_sheet"]);

    const result = await tools[0].execute({}, { sessionId: "s", signal: new AbortController().signal });
    expect(result.output).toBe("ok");
    expect(calls).toEqual(["get_sheet"]);
  });

  it("degrades gracefully when a server fails to connect: error status, no tools, no throw", async () => {
    const connector: McpConnector = async (cfg) => {
      if (cfg.id === "broken") {
        throw new Error("spawn failed");
      }
      return fakeConnection({ tools: [{ name: "play", annotations: { readOnlyHint: true } }] });
    };
    const manager = createMcpServerManager({
      connector,
      confirm: alwaysApprove,
      servers: [config("broken"), config("spotify")],
    });

    await expect(manager.start()).resolves.toBeUndefined();

    const states = manager.states();
    expect(states.find((s) => s.id === "broken")).toMatchObject({ status: "error", toolCount: 0 });
    expect(states.find((s) => s.id === "broken")?.error).toContain("spawn failed");
    // The healthy server is untouched and its tool is available.
    expect(states.find((s) => s.id === "spotify")).toMatchObject({ status: "ready", toolCount: 1 });
    expect(manager.listTools().map((t) => t.name)).toEqual(["mcp_spotify_play"]);
  });

  it("routes a consequential third-party call through the Confirm Gate", async () => {
    const confirm = vi.fn<ToolConfirmGate>(async () => false);
    const connector: McpConnector = async () =>
      fakeConnection({ tools: [{ name: "append_row" }] }); // no annotations -> consequential
    const manager = createMcpServerManager({ connector, confirm, servers: [config("sheets", { displayName: "Google Sheets" })] });

    await manager.start();
    const tool = manager.listTools()[0];
    const result = await tool.execute({ row: "x" }, { sessionId: "s", signal: new AbortController().signal });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].consequence.level).toBe("consequential");
    expect(result.isError).toBe(true); // declined
  });

  it("does not connect a disabled server, and enabling it brings its tools in", async () => {
    const connector: McpConnector = async () => fakeConnection({ tools: [{ name: "note", annotations: { readOnlyHint: true } }] });
    const manager = createMcpServerManager({ connector, confirm: alwaysApprove, servers: [config("obsidian", { enabled: false })] });

    await manager.start();
    expect(manager.states()[0].status).toBe("disabled");
    expect(manager.listTools()).toHaveLength(0);

    await manager.setEnabled("obsidian", true);
    expect(manager.states()[0].status).toBe("ready");
    expect(manager.listTools().map((t) => t.name)).toEqual(["mcp_obsidian_note"]);

    await manager.setEnabled("obsidian", false);
    expect(manager.states()[0].status).toBe("disabled");
    expect(manager.listTools()).toHaveLength(0);
  });

  it("drops a ready server's tools when its connection closes unexpectedly", async () => {
    let fireClose: ((reason?: string) => void) | undefined;
    const connector: McpConnector = async () =>
      fakeConnection({
        tools: [{ name: "play", annotations: { readOnlyHint: true } }],
        captureClose: (fire) => {
          fireClose = fire;
        },
      });
    const manager = createMcpServerManager({ connector, confirm: alwaysApprove, servers: [config("spotify")] });

    await manager.start();
    expect(manager.states()[0].status).toBe("ready");
    expect(manager.listTools()).toHaveLength(1);

    // The server process dies: the transport reports the close, and its tools vanish.
    fireClose?.("process exited");
    expect(manager.states()[0]).toMatchObject({ status: "error", toolCount: 0 });
    expect(manager.states()[0].error).toContain("process exited");
    expect(manager.listTools()).toHaveLength(0);
  });

  it("ignores the close its own deliberate teardown provokes", async () => {
    let fireClose: ((reason?: string) => void) | undefined;
    const connector: McpConnector = async () =>
      fakeConnection({
        tools: [{ name: "note", annotations: { readOnlyHint: true } }],
        captureClose: (fire) => {
          fireClose = fire;
        },
      });
    const manager = createMcpServerManager({ connector, confirm: alwaysApprove, servers: [config("obsidian")] });
    await manager.start();

    // Disabling closes the connection; the resulting close must not flip disabled -> error.
    await manager.setEnabled("obsidian", false);
    fireClose?.();
    expect(manager.states()[0].status).toBe("disabled");
  });

  it("reconnects on refresh, recovering a server that was erroring", async () => {
    let attempt = 0;
    const connector: McpConnector = async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("first attempt fails");
      }
      return fakeConnection({ tools: [{ name: "search", annotations: { readOnlyHint: true } }] });
    };
    const manager = createMcpServerManager({ connector, confirm: alwaysApprove, servers: [config("srv")] });

    await manager.start();
    expect(manager.states()[0].status).toBe("error");

    await manager.refresh("srv");
    expect(manager.states()[0].status).toBe("ready");
    expect(manager.listTools()).toHaveLength(1);
  });

  it("publishes state changes to subscribers", async () => {
    const connector: McpConnector = async () => fakeConnection({ tools: [{ name: "t", annotations: { readOnlyHint: true } }] });
    const manager = createMcpServerManager({ connector, confirm: alwaysApprove, servers: [config("srv")] });
    const seen: string[] = [];
    manager.subscribe((state) => seen.push(state.status));

    await manager.start();
    expect(seen).toContain("connecting");
    expect(seen).toContain("ready");
  });

  it("configure adds a new server, drops a removed one, and closes the dropped connection", async () => {
    const connections: Record<string, McpServerConnection & { closed: boolean }> = {};
    const connector: McpConnector = async (cfg) => {
      const conn = fakeConnection({ tools: [{ name: "t", annotations: { readOnlyHint: true } }] });
      connections[cfg.id] = conn;
      return conn;
    };
    const manager = createMcpServerManager({ connector, confirm: alwaysApprove, servers: [config("a")] });
    await manager.start();
    expect(manager.states().map((s) => s.id)).toEqual(["a"]);

    await manager.configure([config("b")]);
    expect(manager.states().map((s) => s.id)).toEqual(["b"]);
    expect(connections["a"].closed).toBe(true);
    expect(manager.listTools().map((t) => t.name)).toEqual(["mcp_b_t"]);
  });

  it("closes every connection on shutdown", async () => {
    const conn = fakeConnection({ tools: [{ name: "t", annotations: { readOnlyHint: true } }] });
    const manager = createMcpServerManager({ connector: async () => conn, confirm: alwaysApprove, servers: [config("srv")] });
    await manager.start();
    await manager.close();
    expect(conn.closed).toBe(true);
    expect(manager.listTools()).toHaveLength(0);
  });
});
