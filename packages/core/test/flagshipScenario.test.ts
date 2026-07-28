import { describe, expect, it } from "vitest";

import { createTaskAgentRuntime, type TaskAgentRuntimeDependencies } from "../src/taskAgent/taskAgentRuntime.js";
import { createMcpServerManager } from "../src/taskAgent/mcp/mcpServerManager.js";
import { createCompositeToolRegistry } from "../src/taskAgent/mcp/compositeToolRegistry.js";
import type { McpConnector, McpServerConnection, McpToolDefinition } from "../src/taskAgent/mcp/mcpConnection.js";
import type { ToolConfirmGate } from "../src/taskAgent/toolConfirm.js";
import type { TaskAgentTool } from "../src/taskAgent/toolTypes.js";
import type { TaskAgentEvent } from "../src/taskAgent/taskAgentTypes.js";
import type {
  TaskAgentModel,
  TaskAgentModelMessage,
  TaskAgentModelTurn,
  TaskAgentToolCall,
} from "../src/taskAgent/taskAgentModel.js";
import { DEFAULT_ROUTING_CONFIG } from "../src/reasoning/routingConfig.js";

// The flagship scenario (M6-03), as an integration test of M5 + M6 as one product: a Task
// Agent (M5) works a goal through both a local research tool AND an MCP integration tool
// (M6), and the sheet the MCP tool creates flows all the way to the openable artifact the
// Agent Stack card offers. This wires the REAL pieces together - the runtime, the MCP server
// manager + tool translation, and the composite registry that merges local + MCP tools - with
// fakes only at the two true boundaries: the tool-calling model, and the MCP transport.
//
// The canonical example: "research the top 20 TikTok creators and add them to a Google Sheet"
// -> web_search (local) -> create_spreadsheet (Sheets MCP) -> a clickable sheet URL.

const GOAL = "research the top 20 tiktok creators and add them to a google sheet";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/abc123/edit";

const alwaysApprove: ToolConfirmGate = async () => true;

/** A local research tool standing in for the M5 web_search tool. */
function webSearchTool(): TaskAgentTool & { queries: string[] } {
  const queries: string[] = [];
  return {
    name: "web_search",
    description: "search the web",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    queries,
    async execute(input) {
      queries.push(typeof input.query === "string" ? input.query : "");
      return { output: "Found: Khaby Lame, Charli D'Amelio, MrBeast, ... (20 creators with follower counts)." };
    },
  };
}

/**
 * A fake Sheets MCP connection: one `create_spreadsheet` tool that returns the created sheet
 * as an http resource - exactly the shape `translateMcpTool` surfaces as an openable url
 * artifact. `failCall` makes the tool call reject at the transport, to prove a mid-run
 * integration failure degrades gracefully rather than crashing the Session.
 */
function fakeSheetsConnection(options: { failCall?: boolean } = {}): McpServerConnection {
  const tools: McpToolDefinition[] = [
    {
      name: "create_spreadsheet",
      description: "Create a spreadsheet and fill its rows.",
      inputSchema: { type: "object", properties: { rows: { type: "array" } } },
      // No readOnlyHint -> consequential -> gated (a real sheet write should prompt).
    },
  ];
  return {
    async listTools() {
      return tools;
    },
    async callTool() {
      if (options.failCall) {
        throw new Error("401 Unauthorized - the Google sign-in expired");
      }
      return {
        content: [
          { type: "text", text: "Created a spreadsheet with 20 rows." },
          { type: "resource", resource: { uri: SHEET_URL, text: "Top TikTok Creators" } },
        ],
      };
    },
    async close() {},
  };
}

function sheetsManager(options: { failCall?: boolean } = {}) {
  const connector: McpConnector = async () => fakeSheetsConnection(options);
  return createMcpServerManager({
    connector,
    confirm: alwaysApprove,
    servers: [
      { id: "sheets", displayName: "Google Sheets", enabled: true, transport: { kind: "http", url: "https://mcp.test/sheets" } },
    ],
  });
}

function toolCall(id: string, name: string, input: Record<string, unknown> = {}): TaskAgentToolCall {
  return { id, name, input };
}

function goalOf(messages: readonly TaskAgentModelMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  return first !== undefined && first.role === "user" ? first.text : "";
}

/** A stub model replaying a scripted turn sequence per goal, one step per prior assistant turn. */
function scriptedModel(scripts: Record<string, TaskAgentModelTurn[]>): TaskAgentModel {
  return {
    async generate(request) {
      const priorAssistantTurns = request.messages.filter((message) => message.role === "assistant").length;
      const script = scripts[goalOf(request.messages)] ?? [];
      return script[priorAssistantTurns] ?? { text: "done", toolCalls: [] };
    },
  };
}

function deps(overrides: Pick<TaskAgentRuntimeDependencies, "models" | "tools">): TaskAgentRuntimeDependencies {
  return {
    getRoutingConfig: () => ({ ...DEFAULT_ROUTING_CONFIG, reasoning: { vendor: "anthropic", modelSlot: "claude-sonnet-4-6" } }),
    getApiKey: () => "sk-test",
    upstreamFetch: async () => new Response("{}", { status: 200 }),
    ...overrides,
  };
}

function recordEvents(runtime: { subscribe(listener: (event: TaskAgentEvent) => void): () => void }): TaskAgentEvent[] {
  const events: TaskAgentEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return events;
}

describe("flagship scenario: research -> Google Sheet -> clickable result", () => {
  it("researches then writes via the Sheets integration, finishing with the sheet as an openable artifact", async () => {
    const manager = sheetsManager();
    await manager.start();
    // The MCP tool is presented under its namespaced name; the model calls it by that name.
    const sheetsToolName = manager.listTools()[0]!.name;
    expect(sheetsToolName).toBe("mcp_sheets_create_spreadsheet");

    const search = webSearchTool();
    const tools = createCompositeToolRegistry([() => [search], () => manager.listTools()]);
    const model = scriptedModel({
      [GOAL]: [
        { text: "", toolCalls: [toolCall("c1", "web_search", { query: "top 20 tiktok creators by followers" })] },
        { text: "", toolCalls: [toolCall("c2", sheetsToolName, { rows: [["Khaby Lame", "162M"]] })] },
        { text: "All done - your Google Sheet with the top 20 TikTok creators is ready.", toolCalls: [] },
      ],
    });
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools }));
    const events = recordEvents(runtime);

    const snapshot = await runtime.start({ goal: GOAL, sessionId: "flagship" }).completion;

    // The session succeeded, its summary is a plain spoken line, and - crucially - the sheet
    // the MCP tool created is carried through as the openable url artifact for the card.
    expect(snapshot).toMatchObject({
      status: "succeeded",
      result: "All done - your Google Sheet with the top 20 TikTok creators is ready.",
      artifact: { kind: "url", url: SHEET_URL },
    });
    // Research ran before the sheet write - the real two-tool plan across local + MCP.
    expect(search.queries).toEqual(["top 20 tiktok creators by followers"]);
    const toolCalls = events.filter((event) => event.type === "tool-call").map((event) => event.toolName);
    expect(toolCalls).toEqual(["web_search", sheetsToolName]);
    // The succeeded event the Agent Stack reads carries the same artifact.
    expect(events.find((event) => event.type === "succeeded")).toMatchObject({
      artifact: { kind: "url", url: SHEET_URL },
    });
  });

  it("degrades gracefully when the Sheets sign-in expires mid-run (a recoverable tool error, not a crash)", async () => {
    const manager = sheetsManager({ failCall: true });
    await manager.start();
    const sheetsToolName = manager.listTools()[0]!.name;

    const search = webSearchTool();
    const tools = createCompositeToolRegistry([() => [search], () => manager.listTools()]);
    const model = scriptedModel({
      [GOAL]: [
        { text: "", toolCalls: [toolCall("c1", sheetsToolName, { rows: [] })] },
        // The model sees the tool error and finishes with an honest summary instead of crashing.
        { text: "I researched the creators but couldn't add them - your Google sign-in needs renewing.", toolCalls: [] },
      ],
    });
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools }));
    const events = recordEvents(runtime);

    const snapshot = await runtime.start({ goal: GOAL, sessionId: "flagship-fail" }).completion;

    // The Session settles cleanly (never throws), with no misleading artifact to open.
    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.artifact).toBeUndefined();
    // The failing MCP call surfaced as a recoverable error result the model reacted to.
    const toolResult = events.find((event) => event.type === "tool-result");
    expect(toolResult).toMatchObject({ isError: true });
    expect(toolResult && toolResult.type === "tool-result" ? toolResult.output : "").toContain("expired");
  });
});
