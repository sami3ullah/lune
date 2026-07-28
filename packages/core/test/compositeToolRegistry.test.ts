import { describe, expect, it } from "vitest";

import { createCompositeToolRegistry } from "../src/taskAgent/mcp/compositeToolRegistry.js";
import type { TaskAgentTool } from "../src/taskAgent/toolTypes.js";

// The composite registry is the seam that makes MCP tools appear and vanish live. It reads
// its providers on every access, so these tests mutate a provider's backing array between
// calls and assert the registry reflects the change - and that local tools win a name clash.

function tool(name: string, description = name): TaskAgentTool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: `ran ${name}` };
    },
  };
}

describe("createCompositeToolRegistry", () => {
  it("merges the providers' tools in order", () => {
    const registry = createCompositeToolRegistry([() => [tool("open_url")], () => [tool("mcp_x_play")]]);
    expect(registry.list().map((t) => t.name)).toEqual(["open_url", "mcp_x_play"]);
    expect(registry.schemas().map((s) => s.name)).toEqual(["open_url", "mcp_x_play"]);
    expect(registry.get("mcp_x_play")?.name).toBe("mcp_x_play");
  });

  it("reflects a provider's live set changing between calls (a server connecting, then failing)", () => {
    let mcpTools: TaskAgentTool[] = [];
    const registry = createCompositeToolRegistry([() => [tool("open_url")], () => mcpTools]);

    expect(registry.list().map((t) => t.name)).toEqual(["open_url"]);

    mcpTools = [tool("mcp_sheets_append")];
    expect(registry.list().map((t) => t.name)).toEqual(["open_url", "mcp_sheets_append"]);
    expect(registry.get("mcp_sheets_append")).toBeDefined();

    // The server fails: its tools vanish, and a call to one resolves to undefined.
    mcpTools = [];
    expect(registry.list().map((t) => t.name)).toEqual(["open_url"]);
    expect(registry.get("mcp_sheets_append")).toBeUndefined();
  });

  it("keeps the earlier provider's tool on a name clash (local wins over MCP)", () => {
    const registry = createCompositeToolRegistry([
      () => [tool("write_file", "local")],
      () => [tool("write_file", "mcp")],
    ]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("write_file")?.description).toBe("local");
  });
});
