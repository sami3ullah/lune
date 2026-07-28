/**
 * The Task Agent tool registry (M5-01): the runtime's inventory of the tools it may
 * call, keyed by name.
 *
 * It does two jobs and no more: resolve a model-requested tool name to the tool that
 * runs it, and project the tools' schemas into the list the model is told about. Which
 * tools populate a registry is the caller's concern - tests register stubbed tools, and
 * M5-02 registers the real local tool set - so the registry stays a pure lookup with no
 * knowledge of any particular tool.
 */
import type { TaskAgentTool, ToolSchema } from "./toolTypes.js";

/** The Task Agent's tool inventory: name lookup plus the schema list for the model. */
export interface ToolRegistry {
  /** The tool registered under `name`, or `undefined` when nothing matches. */
  get(name: string): TaskAgentTool | undefined;
  /** Every registered tool, in registration order. */
  list(): readonly TaskAgentTool[];
  /**
   * The schema half of every tool (name/description/parameters), in registration order -
   * exactly the tool list a model-request carries, with the `execute` boundary stripped.
   */
  schemas(): ToolSchema[];
}

/**
 * Builds a {@link ToolRegistry} over a fixed set of tools. Two tools sharing a name is a
 * wiring mistake (the model could not address them unambiguously), so it throws rather
 * than silently letting one shadow the other.
 */
export function createToolRegistry(tools: readonly TaskAgentTool[]): ToolRegistry {
  const toolsByName = new Map<string, TaskAgentTool>();
  for (const tool of tools) {
    if (toolsByName.has(tool.name)) {
      throw new Error(`Duplicate Task Agent tool name: '${tool.name}'`);
    }
    toolsByName.set(tool.name, tool);
  }
  const orderedTools = [...toolsByName.values()];

  return {
    get: (name) => toolsByName.get(name),
    list: () => orderedTools,
    schemas: () =>
      orderedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
  };
}
