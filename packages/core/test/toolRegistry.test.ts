import { describe, expect, it } from "vitest";

import { createToolRegistry } from "../src/taskAgent/toolRegistry.js";
import type { TaskAgentTool } from "../src/taskAgent/toolTypes.js";

function stubTool(name: string): TaskAgentTool {
  return {
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute() {
      return { output: name };
    },
  };
}

describe("createToolRegistry", () => {
  it("resolves a tool by name and reports unknown names as undefined", () => {
    const registry = createToolRegistry([stubTool("search"), stubTool("open_url")]);
    expect(registry.get("search")?.name).toBe("search");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("lists tools in registration order", () => {
    const registry = createToolRegistry([stubTool("b"), stubTool("a"), stubTool("c")]);
    expect(registry.list().map((tool) => tool.name)).toEqual(["b", "a", "c"]);
  });

  it("projects the schema half of every tool (execute stripped) for the model's tool list", () => {
    const registry = createToolRegistry([stubTool("search")]);
    expect(registry.schemas()).toEqual([
      {
        name: "search",
        description: "stub search",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ]);
  });

  it("throws on a duplicate tool name so one tool cannot silently shadow another", () => {
    expect(() => createToolRegistry([stubTool("search"), stubTool("search")])).toThrow(
      "Duplicate Task Agent tool name: 'search'",
    );
  });
});
