/**
 * The MCP tool-safety classifier (M6-01): the pure rule that decides whether a third-party
 * tool call is `benign` or `consequential`, reusing the Screen Agent's Consequence Level
 * vocabulary and the local tool set's earn-benign direction (DECISIONS #15). A
 * `consequential` call trips the Confirm Gate before it runs; a `benign` call runs without
 * nagging.
 *
 * Local tools can be classified from their concrete arguments (a shell program, a file
 * overwrite). A third-party tool is opaque - the Core cannot know what `append_row` does - so
 * it classifies from the server-declared annotations only, and starts from the safe
 * assumption: a tool is consequential unless it *explicitly* declares itself read-only. That
 * direction matters, and it is the whole reason the epic's "overwrite a sheet trips the
 * Confirm Gate" acceptance holds without per-integration knowledge: a server that says
 * nothing leaves its tools gated.
 *
 * Pure and unit-tested, like {@link import("../toolConsequence.js")}; the gate UX is the
 * Shell's, injected behind the same {@link import("../toolConfirm.js").ToolConfirmGate} seam.
 */
import type { ToolConsequence } from "../toolConsequence.js";
import type { McpToolAnnotations } from "./mcpConnection.js";

/** The inputs the classifier needs: the tool's name (for the reason) and its annotations. */
export interface McpToolClassificationInput {
  /** The tool's name, used in the human reason the gate speaks. */
  name: string;
  /** The server-declared behavioural hints, if any. */
  annotations?: McpToolAnnotations;
}

/**
 * Classifies a third-party MCP tool call. Benign only when the server explicitly marks the
 * tool `readOnlyHint: true` and does not also mark it destructive (a contradiction resolves
 * to "ask"); every other case - no annotations, `readOnlyHint` absent or false, or a
 * destructive hint - is consequential and prompts. Backs the acceptance criterion
 * "consequential third-party calls (e.g. overwrite a sheet) trip the Confirm Gate".
 */
export function classifyMcpTool(tool: McpToolClassificationInput): ToolConsequence {
  const annotations = tool.annotations;
  if (annotations?.destructiveHint === true) {
    return {
      level: "consequential",
      reason: `calls '${tool.name}', which can modify or delete data`,
    };
  }
  if (annotations?.readOnlyHint === true) {
    return { level: "benign", reason: `calls the read-only tool '${tool.name}'` };
  }
  return {
    level: "consequential",
    reason: `calls the third-party tool '${tool.name}', whose effects aren't known to be safe`,
  };
}
