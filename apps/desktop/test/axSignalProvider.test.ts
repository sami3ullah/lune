import { describe, expect, it } from "vitest";
import {
  createMacAxSignalProvider,
  parseAxSignalOutput,
} from "../src/main/agent/axSignalProvider";

// The accessibility read (M2-05) is a best-effort OS edge: the `osascript` spawn itself is
// untested, but the JSON shape it prints - and the many partial/garbage/degraded cases -
// runs through this pure parser, which is what these tests pin. The provider's own contract
// (never reject; degrade to null) is covered against an injected reader.

describe("parseAxSignalOutput", () => {
  it("returns null for empty / whitespace output (no accessibility read)", () => {
    expect(parseAxSignalOutput("")).toBeNull();
    expect(parseAxSignalOutput("   \n ")).toBeNull();
  });

  it("returns null for unparseable output", () => {
    expect(parseAxSignalOutput("not json at all")).toBeNull();
    expect(parseAxSignalOutput("{ broken")).toBeNull();
  });

  it("returns null when the read carries nothing useful", () => {
    expect(parseAxSignalOutput("{}")).toBeNull();
    expect(parseAxSignalOutput(JSON.stringify({ elements: [] }))).toBeNull();
  });

  it("parses the focused element's role and title", () => {
    const output = JSON.stringify({ focused: { role: "AXTextField", title: "Search" } });
    expect(parseAxSignalOutput(output)).toEqual({
      focusedRole: "AXTextField",
      focusedLabel: "Search",
    });
  });

  it("parses element frames, mapping w/h to width/height", () => {
    const output = JSON.stringify({
      elements: [
        { x: 100, y: 200, w: 80, h: 24, role: "AXButton", title: "Send" },
        { x: 10, y: 20, w: 40, h: 12, role: "AXLink" },
      ],
    });
    expect(parseAxSignalOutput(output)).toEqual({
      elements: [
        { x: 100, y: 200, width: 80, height: 24, role: "AXButton", label: "Send" },
        { x: 10, y: 20, width: 40, height: 12, role: "AXLink" },
      ],
    });
  });

  it("drops elements missing a finite frame (a partial accessibility node)", () => {
    const output = JSON.stringify({
      elements: [
        { x: 100, y: 200, w: 80, role: "AXButton" }, // no height
        { x: null, y: 20, w: 40, h: 12, role: "AXLink" }, // null coordinate
        { x: 5, y: 6, w: 7, h: 8, role: "AXButton", title: "keep" },
      ],
    });
    expect(parseAxSignalOutput(output)?.elements).toEqual([
      { x: 5, y: 6, width: 7, height: 8, role: "AXButton", label: "keep" },
    ]);
  });

  it("tolerates a null title/role on an otherwise-valid element", () => {
    const output = JSON.stringify({ elements: [{ x: 1, y: 2, w: 3, h: 4, role: null, title: null }] });
    expect(parseAxSignalOutput(output)?.elements).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
  });
});

describe("createMacAxSignalProvider - degradation contract", () => {
  it("returns the parsed signal from the injected reader", async () => {
    const provider = createMacAxSignalProvider({
      runReader: async () => JSON.stringify({ focused: { role: "AXButton", title: "OK" } }),
    });
    await expect(provider.capture()).resolves.toEqual({ focusedRole: "AXButton", focusedLabel: "OK" });
  });

  it("degrades to null when the reader yields nothing", async () => {
    const provider = createMacAxSignalProvider({ runReader: async () => "" });
    await expect(provider.capture()).resolves.toBeNull();
  });

  it("never rejects - a throwing reader degrades to null", async () => {
    const provider = createMacAxSignalProvider({
      runReader: async () => {
        throw new Error("osascript blew up");
      },
    });
    await expect(provider.capture()).resolves.toBeNull();
  });
});
