import { describe, expect, it } from "vitest";

import { classifyMcpTool } from "../src/taskAgent/mcp/mcpToolConsequence.js";

// The MCP consequence classifier reuses the local tool set's earn-benign philosophy: a
// third-party tool is consequential (and gated) unless it clearly declares itself read-only.
// Annotations are server-supplied and advisory, so anything short of an explicit read-only
// hint stays gated - the wrong default here silently overwrites a user's sheet.

describe("classifyMcpTool", () => {
  it("earns benign only for an explicit read-only tool", () => {
    const consequence = classifyMcpTool({ name: "get_sheet", annotations: { readOnlyHint: true } });
    expect(consequence.level).toBe("benign");
    expect(consequence.reason).toContain("get_sheet");
  });

  it("gates a tool with no annotations at all (the safe default)", () => {
    expect(classifyMcpTool({ name: "append_row" }).level).toBe("consequential");
  });

  it("gates a tool that is not marked read-only", () => {
    expect(classifyMcpTool({ name: "append_row", annotations: {} }).level).toBe("consequential");
    expect(classifyMcpTool({ name: "append_row", annotations: { readOnlyHint: false } }).level).toBe(
      "consequential",
    );
  });

  it("gates a destructive tool even when it also claims read-only (contradiction resolves to ask)", () => {
    const consequence = classifyMcpTool({
      name: "clear_sheet",
      annotations: { readOnlyHint: true, destructiveHint: true },
    });
    expect(consequence.level).toBe("consequential");
  });

  it("explains a destructive tool distinctly from a plain write", () => {
    expect(
      classifyMcpTool({ name: "delete_playlist", annotations: { destructiveHint: true } }).reason,
    ).toMatch(/delete|modif/i);
  });
});
