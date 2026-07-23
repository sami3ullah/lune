import { describe, expect, it } from "vitest";

import {
  canonicalHotkeyToken,
  DEFAULT_HOTKEY_TOKEN,
  displayHotkeyToken,
  formatHotkeyToken,
  parseHotkeyToken,
  validateHotkeyToken,
} from "../src/ipc/hotkey";

/**
 * Unit tests for the push-to-talk hotkey editor logic (ticket 13). Hotkey config
 * parsing is one of the named Shell pure-logic seams, exercised here directly: the
 * default token is ctrl+option, parsing is order/case-insensitive, validating an edit
 * is strict and explains rejections, and display reads back the way the editor shows
 * it. The persisted form is the "+"-joined token the Core routing config stores.
 */

describe("DEFAULT_HOTKEY_TOKEN", () => {
  it("is the modifier-only ctrl+option chord (spec default)", () => {
    expect(DEFAULT_HOTKEY_TOKEN).toBe("control+alt");
  });
});

describe("parseHotkeyToken", () => {
  it("parses modifiers order- and case-insensitively into canonical order", () => {
    expect(parseHotkeyToken("Alt+Control")).toEqual({ modifiers: ["control", "alt"], key: null });
  });

  it("parses a chord with a main key, normalizing the key", () => {
    expect(parseHotkeyToken("control+space")).toEqual({ modifiers: ["control"], key: "Space" });
  });

  it("returns null for an unrecognized segment (a typo is not silently reinterpreted)", () => {
    expect(parseHotkeyToken("control+boguskey")).toBeNull();
    expect(parseHotkeyToken("")).toBeNull();
  });

  it("returns null when two main keys are given", () => {
    expect(parseHotkeyToken("control+A+B")).toBeNull();
  });
});

describe("formatHotkeyToken", () => {
  it("renders canonical modifier order plus key", () => {
    expect(formatHotkeyToken({ modifiers: ["shift", "control"], key: "Space" })).toBe(
      "control+shift+Space",
    );
  });
});

describe("validateHotkeyToken", () => {
  it("accepts a two-modifier chord, returning the canonical token", () => {
    expect(validateHotkeyToken("alt+control")).toEqual({ ok: true, token: "control+alt" });
  });

  it("accepts one modifier plus a main key", () => {
    expect(validateHotkeyToken("control+space")).toEqual({ ok: true, token: "control+Space" });
  });

  it("rejects a modifier-only chord with fewer than two modifiers", () => {
    expect(validateHotkeyToken("control")).toMatchObject({ ok: false });
  });

  it("rejects a bare key with no modifiers", () => {
    expect(validateHotkeyToken("A")).toMatchObject({ ok: false });
  });

  it("rejects an unsupported key", () => {
    expect(validateHotkeyToken("control+Enter")).toMatchObject({ ok: false });
  });
});

describe("canonicalHotkeyToken", () => {
  it("keeps a valid token canonical", () => {
    expect(canonicalHotkeyToken("alt+control")).toBe("control+alt");
  });

  it("falls back to the default for an invalid token", () => {
    expect(canonicalHotkeyToken("control")).toBe(DEFAULT_HOTKEY_TOKEN);
    expect(canonicalHotkeyToken("junk")).toBe(DEFAULT_HOTKEY_TOKEN);
  });
});

describe("displayHotkeyToken", () => {
  it("renders macOS modifier names", () => {
    expect(displayHotkeyToken("control+alt")).toBe("ctrl + option");
    expect(displayHotkeyToken("control+shift+Space")).toBe("ctrl + shift + Space");
  });

  it("falls back to the raw token when unparseable", () => {
    expect(displayHotkeyToken("weird")).toBe("weird");
  });
});
