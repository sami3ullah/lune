import { describe, expect, it } from "vitest";

import { SettingsStore, type AppSettings } from "../src/main/settings/settingsStore";
import { DEFAULT_HOTKEY_TOKEN } from "../src/ipc/hotkey";

/**
 * Unit tests for the Settings persistence store (ticket 13). It is the one config file
 * the Shell writes and the Core reads; reads must be tolerant (a missing/partial file
 * yields complete defaults), and writes must round-trip the whole document including
 * the Core's routing slice, so a Shell-only edit never drops it.
 */

function inMemoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set("/config.json", initial);
  }
  return {
    files,
    read: (path: string): string => {
      const contents = files.get(path);
      if (contents === undefined) {
        throw new Error("ENOENT");
      }
      return contents;
    },
    write: (path: string, contents: string): void => {
      files.set(path, contents);
    },
  };
}

function makeStore(fs: ReturnType<typeof inMemoryFs>) {
  return new SettingsStore("/config.json", fs.read, fs.write);
}

describe("SettingsStore.read", () => {
  it("returns complete defaults when no file exists", () => {
    const settings = makeStore(inMemoryFs()).read();
    expect(settings.reasoning.vendor).toBe("google");
    expect(settings.speech.voice).toBe("af_heart");
    expect(settings.streamingText).toBe(true);
    expect(settings.hotkey).toBe(DEFAULT_HOTKEY_TOKEN);
  });

  it("reads a complete saved document verbatim", () => {
    const saved: AppSettings = {
      reasoning: { vendor: "openai", modelSlot: "gpt-4o" },
      speech: { voice: "am_michael" },
      streamingText: false,
      hotkey: "control+shift+Space",
    };
    // Persisted via write (Core `{ pushToTalk }` shape), then read back.
    const fs = inMemoryFs();
    makeStore(fs).write(saved);
    expect(makeStore(fs).read()).toEqual(saved);
  });

  it("falls back per-field on a partial file", () => {
    const settings = makeStore(inMemoryFs(JSON.stringify({ streamingText: false }))).read();
    // Missing routing slice defaults to Gemini; hotkey defaults; streaming honored.
    expect(settings.reasoning.vendor).toBe("google");
    expect(settings.streamingText).toBe(false);
    expect(settings.hotkey).toBe(DEFAULT_HOTKEY_TOKEN);
  });

  it("tolerates non-JSON as full defaults", () => {
    const settings = makeStore(inMemoryFs("not json{")).read();
    expect(settings.reasoning.vendor).toBe("google");
    expect(settings.streamingText).toBe(true);
  });
});

describe("SettingsStore.write", () => {
  it("round-trips the whole document, keeping the Core routing slice", () => {
    const fs = inMemoryFs();
    const store = makeStore(fs);
    const settings: AppSettings = {
      reasoning: { vendor: "anthropic", modelSlot: "claude-sonnet-4-6" },
      speech: { voice: "bm_george" },
      streamingText: false,
      hotkey: "control+alt",
    };
    store.write(settings);

    // The persisted file carries the routing slice the Core reads, hotkey in its shape.
    const persisted = JSON.parse(fs.files.get("/config.json") as string);
    expect(persisted.reasoning).toEqual({ vendor: "anthropic", modelSlot: "claude-sonnet-4-6" });
    expect(persisted.hotkey).toEqual({ pushToTalk: "control+alt" });
    // And a re-read reproduces the document.
    expect(makeStore(fs).read()).toEqual(settings);
  });
});

describe("SettingsStore.getStreamingText", () => {
  it("reflects the latest saved value (live read)", () => {
    const fs = inMemoryFs();
    const store = makeStore(fs);
    expect(store.getStreamingText()).toBe(true);
    store.write({
      reasoning: { vendor: "google", modelSlot: "gemini-2.5-flash" },
      speech: { voice: "af_heart" },
      streamingText: false,
      hotkey: DEFAULT_HOTKEY_TOKEN,
    });
    expect(store.getStreamingText()).toBe(false);
  });
});
