import { describe, expect, it, vi } from "vitest";

import {
  mcpPresentedToolName,
  translateMcpTool,
} from "../src/taskAgent/mcp/mcpToolTranslation.js";
import type {
  McpServerConnection,
  McpToolCallResult,
  McpToolDefinition,
} from "../src/taskAgent/mcp/mcpConnection.js";
import type { ToolConfirmGate } from "../src/taskAgent/toolConfirm.js";
import type { ToolExecutionContext } from "../src/taskAgent/toolTypes.js";

// Translation is where a discovered MCP tool becomes an ordinary Task Agent tool: a
// namespaced name, a normalised schema, the shared Confirm Gate on consequential calls, and
// the MCP content result flattened into one text output (with an openable http resource
// surfaced as an artifact). These tests drive it with a fake connection and a scripted gate.

const context: ToolExecutionContext = { sessionId: "s1", signal: new AbortController().signal };

function fakeConnection(overrides: Partial<McpServerConnection> = {}): McpServerConnection & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async listTools() {
      return [];
    },
    async callTool(name, args): Promise<McpToolCallResult> {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "done" }] };
    },
    async close() {},
    ...overrides,
  };
}

const alwaysApprove: ToolConfirmGate = async () => true;
const alwaysDecline: ToolConfirmGate = async () => false;

function translate(
  definition: McpToolDefinition,
  connection: McpServerConnection,
  confirm: ToolConfirmGate = alwaysApprove,
) {
  return translateMcpTool(definition, {
    serverId: "google-sheets",
    serverDisplayName: "Google Sheets",
    connection,
    confirm,
  });
}

describe("mcpPresentedToolName", () => {
  it("namespaces by server and sanitises to a wire-safe name", () => {
    expect(mcpPresentedToolName("google-sheets", "append_row")).toBe("mcp_google-sheets_append_row");
    expect(mcpPresentedToolName("weird id!", "do.it")).toBe("mcp_weird_id__do_it");
  });

  it("truncates to the 64-char vendor limit", () => {
    const name = mcpPresentedToolName("server", "x".repeat(200));
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("translateMcpTool", () => {
  it("presents a namespaced tool and normalises a missing input schema", () => {
    const tool = translate({ name: "append_row" }, fakeConnection());
    expect(tool.name).toBe("mcp_google-sheets_append_row");
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
    expect(tool.description).toContain("Google Sheets");
  });

  it("keeps a valid object input schema verbatim", () => {
    const schema = { type: "object" as const, properties: { row: { type: "string" } }, required: ["row"] };
    const tool = translate({ name: "append_row", inputSchema: schema }, fakeConnection());
    expect(tool.parameters).toBe(schema);
  });

  it("gates a consequential (unannotated) call and calls the tool once approved", async () => {
    const connection = fakeConnection();
    const confirm = vi.fn(alwaysApprove);
    const tool = translate({ name: "append_row" }, connection, confirm);

    const result = await tool.execute({ row: "a,b" }, context);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(connection.calls).toEqual([{ name: "append_row", args: { row: "a,b" } }]);
    expect(result.output).toBe("done");
  });

  it("does not call the tool when the gate declines, and reports back to the model", async () => {
    const connection = fakeConnection();
    const tool = translate({ name: "append_row" }, connection, alwaysDecline);

    const result = await tool.execute({ row: "a,b" }, context);

    expect(connection.calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("declined");
  });

  it("skips the gate entirely for a read-only tool", async () => {
    const connection = fakeConnection();
    const confirm = vi.fn(alwaysApprove);
    const tool = translate({ name: "get_sheet", annotations: { readOnlyHint: true } }, connection, confirm);

    await tool.execute({}, context);

    expect(confirm).not.toHaveBeenCalled();
    expect(connection.calls).toEqual([{ name: "get_sheet", args: {} }]);
  });

  it("passes through a server-reported error as a recoverable result", async () => {
    const connection = fakeConnection({
      async callTool() {
        return { content: [{ type: "text", text: "bad range" }], isError: true };
      },
    });
    const tool = translate({ name: "get_sheet", annotations: { readOnlyHint: true } }, connection);

    const result = await tool.execute({}, context);

    expect(result.isError).toBe(true);
    expect(result.output).toBe("bad range");
  });

  it("turns a transport failure into a recoverable result rather than throwing", async () => {
    const connection = fakeConnection({
      async callTool() {
        throw new Error("ECONNREFUSED");
      },
    });
    const tool = translate({ name: "get_sheet", annotations: { readOnlyHint: true } }, connection);

    const result = await tool.execute({}, context);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("could not be reached");
  });

  it("surfaces an http resource as an openable url artifact", async () => {
    const connection = fakeConnection({
      async callTool() {
        return {
          content: [
            { type: "text", text: "Created the sheet." },
            { type: "resource", resource: { uri: "https://docs.google.com/spreadsheets/d/abc" } },
          ],
        };
      },
    });
    const tool = translate({ name: "create_sheet" }, connection, alwaysApprove);

    const result = await tool.execute({}, context);

    expect(result.artifact).toEqual({ kind: "url", url: "https://docs.google.com/spreadsheets/d/abc" });
    expect(result.output).toContain("Created the sheet.");
  });
});
