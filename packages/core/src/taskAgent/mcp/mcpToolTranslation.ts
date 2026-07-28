/**
 * MCP tool translation (M6-01): turns one discovered {@link McpToolDefinition} into a
 * {@link TaskAgentTool} the runtime can call alongside the local tools, with no change to the
 * runtime or the registry contract - a translated MCP tool *is* an ordinary tool.
 *
 * Translation does four things and no more:
 *   - presents a **namespaced, wire-safe name** (`mcp_<server>_<tool>`) so two servers'
 *     same-named tools never collide and every vendor's tool-name rules (`[A-Za-z0-9_-]`, 64
 *     chars) are met; the original server-local name is captured for the call;
 *   - normalises the server's `inputSchema` into the JSON-Schema the model is told about;
 *   - gates the call: it classifies the tool via {@link classifyMcpTool} and, when
 *     consequential, awaits the injected {@link ToolConfirmGate} - the *same* gate the local
 *     tools use, so a sheet-overwrite prompts exactly as a file-overwrite does;
 *   - runs the call through the server {@link McpServerConnection} and flattens the MCP
 *     content result into the single text output a tool result carries, surfacing an http(s)
 *     resource as an openable artifact.
 *
 * A translated tool's `execute` never throws for an expected condition (a declined gate, a
 * server-reported error, a transport failure): those are recoverable results the model sees
 * and adapts to, matching the local tool set.
 */
import type { ToolConfirmGate } from "../toolConfirm.js";
import type {
  TaskAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolParameterSchema,
  ToolArtifact,
} from "../toolTypes.js";
import { classifyMcpTool } from "./mcpToolConsequence.js";
import type {
  McpContentBlock,
  McpServerConnection,
  McpToolCallResult,
  McpToolDefinition,
} from "./mcpConnection.js";

/** The prefix that marks a tool as MCP-provided, distinguishing it from the local set. */
const MCP_TOOL_NAME_PREFIX = "mcp";

/** Vendor tool-name ceiling (Anthropic/OpenAI both cap at 64 chars, `[A-Za-z0-9_-]`). */
const MAX_TOOL_NAME_LENGTH = 64;

/** The dependencies one MCP tool is translated against. */
export interface McpToolTranslationContext {
  /** The owning server's id, used to namespace the tool name. */
  serverId: string;
  /** The owning server's human label, spoken by the Confirm Gate. */
  serverDisplayName: string;
  /** The live connection the call is issued over. */
  connection: McpServerConnection;
  /** The Confirm Gate a consequential call must pass (the Shell's voice gate). */
  confirm: ToolConfirmGate;
}

/**
 * The wire-safe, namespaced name a server-local tool is presented to the model under.
 * Non-`[A-Za-z0-9_-]` characters (in either the server id or the tool name) collapse to `_`,
 * and the whole is truncated to the vendor limit. Two distinct server tools can only collide
 * here if their ids *and* names sanitise identically; the manager keeps server ids unique and
 * the registry keeps first on any residual clash, so a collision drops a tool rather than
 * shadowing one silently.
 */
export function mcpPresentedToolName(serverId: string, toolName: string): string {
  const safeServer = sanitiseSegment(serverId);
  const safeTool = sanitiseSegment(toolName);
  return `${MCP_TOOL_NAME_PREFIX}_${safeServer}_${safeTool}`.slice(0, MAX_TOOL_NAME_LENGTH);
}

/** Replaces every character outside `[A-Za-z0-9_-]` with `_`. */
function sanitiseSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Translates one discovered MCP tool into a {@link TaskAgentTool}. */
export function translateMcpTool(
  definition: McpToolDefinition,
  context: McpToolTranslationContext,
): TaskAgentTool {
  const { serverId, serverDisplayName, connection, confirm } = context;
  const presentedName = mcpPresentedToolName(serverId, definition.name);
  const displayLabel = definition.annotations?.title ?? definition.name;
  const consequence = classifyMcpTool({ name: definition.name, annotations: definition.annotations });

  return {
    name: presentedName,
    description: describeTool(definition, serverDisplayName),
    parameters: normaliseInputSchema(definition.inputSchema),
    async execute(input, executionContext: ToolExecutionContext): Promise<ToolExecutionResult> {
      if (consequence.level === "consequential") {
        const approved = await confirm({
          toolName: presentedName,
          summary: `use ${serverDisplayName} to ${describeAction(displayLabel)}`,
          consequence,
          signal: executionContext.signal,
        });
        if (!approved) {
          return { output: `The user declined the ${serverDisplayName} action.`, isError: true };
        }
      }

      let result: McpToolCallResult;
      try {
        result = await connection.callTool(definition.name, input, executionContext.signal);
      } catch (error) {
        // A transport-level failure (the server died, the network dropped) is recoverable
        // from the model's view: report it as a tool error so the Session degrades cleanly
        // rather than crashing.
        return {
          output: `The ${serverDisplayName} tool '${definition.name}' could not be reached: ${errorMessage(error)}`,
          isError: true,
        };
      }
      return toToolResult(result);
    },
  };
}

/** Builds the model-facing description, always attributing the tool to its server. */
function describeTool(definition: McpToolDefinition, serverDisplayName: string): string {
  const base = definition.description?.trim();
  const attribution = `(via the ${serverDisplayName} integration)`;
  return base && base.length > 0 ? `${base} ${attribution}` : `A ${serverDisplayName} tool. ${attribution}`;
}

/** A short verb phrase for the Confirm Gate line, e.g. "append_row" -> "append row". */
function describeAction(label: string): string {
  return label.replace(/_/g, " ").trim();
}

/**
 * Normalises a server's `inputSchema` into the JSON-Schema the model is told about. MCP
 * input schemas are always object schemas, but a server may omit it entirely or hand back
 * something odd; a missing/non-object schema becomes an empty object schema so the tool is
 * still callable (with no arguments) rather than rejected.
 */
function normaliseInputSchema(schema: ToolParameterSchema | undefined): ToolParameterSchema {
  if (schema && typeof schema === "object" && schema.type === "object" && isRecord(schema.properties)) {
    return schema;
  }
  return { type: "object", properties: {} };
}

/**
 * Flattens an MCP call result into a {@link ToolExecutionResult}: text blocks joined by blank
 * lines, other blocks summarised, and the first http(s) resource surfaced as an openable
 * artifact (so a "created the sheet" result yields a clickable Agent Stack card). An empty
 * result still returns a readable line.
 */
function toToolResult(result: McpToolCallResult): ToolExecutionResult {
  const parts: string[] = [];
  let artifact: ToolArtifact | undefined;

  for (const block of result.content) {
    const { text, url } = interpretBlock(block);
    if (text !== null) {
      parts.push(text);
    }
    if (artifact === undefined && url !== null) {
      artifact = { kind: "url", url };
    }
  }

  const output = parts.join("\n\n").trim();
  return {
    output: output.length > 0 ? output : result.isError === true ? "The tool reported an error." : "The tool ran with no output.",
    isError: result.isError === true ? true : undefined,
    artifact,
  };
}

/**
 * The contributions of one content block in a single pass: the `text` it adds to the
 * flattened output (or `null`), and the http(s) `url` it offers as an openable artifact (or
 * `null`). One walk over the block's shape, so the text and artifact reads never drift apart.
 */
function interpretBlock(block: McpContentBlock): { text: string | null; url: string | null } {
  if (block.type === "text") {
    const text = (block as { text?: unknown }).text;
    return { text: typeof text === "string" ? text : null, url: null };
  }
  if (block.type === "resource") {
    const resource = (block as { resource?: { uri?: unknown; text?: unknown } }).resource;
    const uri = typeof resource?.uri === "string" ? resource.uri : null;
    const text =
      typeof resource?.text === "string" && resource.text.length > 0 ? resource.text : uri;
    return { text, url: httpUrl(uri) };
  }
  if (block.type === "resource_link") {
    const uri = typeof (block as { uri?: unknown }).uri === "string" ? (block as { uri: string }).uri : null;
    return { text: uri, url: httpUrl(uri) };
  }
  // An image, audio, or unknown block: a short placeholder so the model knows something came
  // back without the Core having to render binary content into text.
  return { text: `[${block.type} content]`, url: null };
}

/** A candidate URI, but only when it is http(s) - the shape an openable url artifact wants. */
function httpUrl(uri: string | null): string | null {
  return uri !== null && /^https?:\/\//i.test(uri) ? uri : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
