import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTING_CONFIG,
  RoutingConfigStore,
  loadRoutingConfig,
  parseRoutingConfig,
} from "../src/reasoning/routingConfig";

/**
 * Unit tests for the Reasoning routing config model. These cover the tolerant
 * parse/merge/load behaviour the Core relies on to keep routing regardless of what
 * the (user-facing) config file contains, plus the live-reload store the Electron
 * main process drives on a file change. Carried from v1's `snappyConfig` suite,
 * narrowed to the Reasoning Capability and the "Gemini as default" rule.
 */

describe("DEFAULT_ROUTING_CONFIG", () => {
  it("defaults Reasoning to Gemini", () => {
    expect(DEFAULT_ROUTING_CONFIG.reasoning.vendor).toBe("google");
  });
});

describe("parseRoutingConfig", () => {
  it("parses a complete, valid config verbatim", () => {
    const rawJson = JSON.stringify({ reasoning: { vendor: "openai", modelSlot: "gpt-4o" } });
    expect(parseRoutingConfig(rawJson)).toEqual({
      reasoning: { vendor: "openai", modelSlot: "gpt-4o" },
    });
  });

  it("accepts each wired Vendor", () => {
    for (const vendor of ["anthropic", "openai", "google"] as const) {
      const config = parseRoutingConfig(JSON.stringify({ reasoning: { vendor, modelSlot: "m" } }));
      expect(config.reasoning.vendor).toBe(vendor);
    }
  });

  it("falls back to the default Vendor for an unknown/invalid Vendor", () => {
    const config = parseRoutingConfig(
      JSON.stringify({ reasoning: { vendor: "xai", modelSlot: "grok-4" } }),
    );
    // An unwired Vendor is not accepted; the model slot is validated independently
    // and kept when non-empty.
    expect(config.reasoning.vendor).toBe(DEFAULT_ROUTING_CONFIG.reasoning.vendor);
    expect(config.reasoning.modelSlot).toBe("grok-4");
  });

  it("fills a missing Reasoning selection from the defaults", () => {
    expect(parseRoutingConfig("{}")).toEqual(DEFAULT_ROUTING_CONFIG);
  });

  it("falls back per-field when the selection is partial or invalid", () => {
    const config = parseRoutingConfig(JSON.stringify({ reasoning: { vendor: "nonsense", modelSlot: "" } }));
    // Invalid Vendor and empty modelSlot both fall back to the defaults.
    expect(config.reasoning).toEqual(DEFAULT_ROUTING_CONFIG.reasoning);
  });

  it("keeps a valid Vendor while defaulting a missing model slot", () => {
    const config = parseRoutingConfig(JSON.stringify({ reasoning: { vendor: "anthropic" } }));
    expect(config.reasoning.vendor).toBe("anthropic");
    expect(config.reasoning.modelSlot).toBe(DEFAULT_ROUTING_CONFIG.reasoning.modelSlot);
  });

  it("returns the defaults wholesale when the file is not valid JSON", () => {
    expect(parseRoutingConfig("this is not json")).toEqual(DEFAULT_ROUTING_CONFIG);
  });

  it("returns the defaults when the JSON is not an object", () => {
    expect(parseRoutingConfig("42")).toEqual(DEFAULT_ROUTING_CONFIG);
    expect(parseRoutingConfig("null")).toEqual(DEFAULT_ROUTING_CONFIG);
  });

  it("does not let a parsed result mutate the shared defaults constant", () => {
    const config = parseRoutingConfig("{}");
    config.reasoning.modelSlot = "mutated";
    expect(DEFAULT_ROUTING_CONFIG.reasoning.modelSlot).not.toBe("mutated");
  });
});

describe("loadRoutingConfig", () => {
  it("reads and parses the file at the given path", () => {
    const fileContentsByPath: Record<string, string> = {
      "/config.json": JSON.stringify({ reasoning: { vendor: "openai", modelSlot: "gpt-4o" } }),
    };
    const config = loadRoutingConfig("/config.json", (path) => fileContentsByPath[path]);
    expect(config.reasoning).toEqual({ vendor: "openai", modelSlot: "gpt-4o" });
  });

  it("returns the defaults when no path is configured", () => {
    const config = loadRoutingConfig(undefined, () => {
      throw new Error("reader should not be called");
    });
    expect(config).toEqual(DEFAULT_ROUTING_CONFIG);
  });

  it("returns the defaults when the file cannot be read", () => {
    const config = loadRoutingConfig("/missing.json", () => {
      throw new Error("ENOENT");
    });
    expect(config).toEqual(DEFAULT_ROUTING_CONFIG);
  });
});

describe("RoutingConfigStore", () => {
  it("loads the config on construction and reloads it on demand", () => {
    let fileContents = JSON.stringify({ reasoning: { vendor: "anthropic", modelSlot: "claude-sonnet-4-6" } });
    const store = new RoutingConfigStore("/config.json", () => fileContents);

    expect(store.getConfig().reasoning.vendor).toBe("anthropic");

    // The Shell writes a new Setting; the main process calls reload() on the change.
    fileContents = JSON.stringify({ reasoning: { vendor: "openai", modelSlot: "gpt-4o" } });
    // Not visible until reloaded.
    expect(store.getConfig().reasoning.vendor).toBe("anthropic");

    const reloaded = store.reload();
    expect(reloaded.reasoning).toEqual({ vendor: "openai", modelSlot: "gpt-4o" });
    expect(store.getConfig().reasoning.vendor).toBe("openai");
  });
});
