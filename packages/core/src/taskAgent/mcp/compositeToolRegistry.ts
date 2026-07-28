/**
 * The composite tool registry (M6-01): a {@link ToolRegistry} whose contents are recomputed
 * live from a set of providers, so the Task Agent runtime sees local tools *and* the current
 * MCP tools without ever holding a stale snapshot.
 *
 * The runtime asks its registry for `schemas()` at the start of each step and `get(name)`
 * before each call. The base {@link import("../toolRegistry.js").createToolRegistry} answers
 * from a fixed set - right for the local tools, wrong for MCP tools that appear when a server
 * connects and *vanish when it fails*. This registry answers from its providers on every
 * call, which is what makes the epic's "server failures degrade gracefully (tools vanish)"
 * acceptance fall out for free: when the manager drops a server's tools - on a connect/
 * discovery failure, a disable, or an unexpected disconnect it detects - the next step simply
 * doesn't offer them, and a mid-step call to one resolves to `undefined` (a clean "unknown
 * tool" the model adapts to). A call to a server that dies mid-step still degrades cleanly:
 * the translated tool turns the transport failure into a recoverable error result.
 *
 * Providers are consulted in order and earlier ones win on a name clash - so the local tools,
 * listed first, can never be shadowed by a third-party tool claiming their name. A residual
 * clash *within* the dynamic set keeps the first occurrence rather than throwing: a live tool
 * set must never crash a running Session over a transient duplicate (unlike the static
 * registry, where a duplicate is a wiring bug caught at construction).
 */
import type { ToolRegistry } from "../toolRegistry.js";
import type { TaskAgentTool, ToolSchema } from "../toolTypes.js";

/** A source of tools, re-read on every registry access so its live set is always reflected. */
export type ToolProvider = () => readonly TaskAgentTool[];

/**
 * Builds a {@link ToolRegistry} that merges the providers' current tools on every access.
 * Pass the local tool set as the first provider (a `() => localTools` thunk over the fixed
 * array) and the MCP manager's `listTools` as a later one; the order sets precedence.
 */
export function createCompositeToolRegistry(providers: readonly ToolProvider[]): ToolRegistry {
  /** The current merged, de-duplicated tool list, first-wins across providers. */
  function currentTools(): TaskAgentTool[] {
    const byName = new Map<string, TaskAgentTool>();
    for (const provider of providers) {
      for (const tool of provider()) {
        if (!byName.has(tool.name)) {
          byName.set(tool.name, tool);
        }
      }
    }
    return [...byName.values()];
  }

  return {
    get: (name) => currentTools().find((tool) => tool.name === name),
    list: () => currentTools(),
    schemas: (): ToolSchema[] =>
      currentTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
  };
}
