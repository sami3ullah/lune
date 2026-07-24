import { describe, expect, it, vi } from "vitest";
import type { AgentAction } from "@lune/core";
import type { AgentDisplayGeometry } from "../src/main/agent/agentCoordinateRemap";
import {
  AccessibilityNotGrantedError,
  createSyntheticInputExecutor,
  parseKeyCombination,
  type ClipboardWriter,
  type GlobalPoint,
  type KeyCombination,
  type NativeInputBackend,
  type ScrollDirection,
} from "../src/main/agent/syntheticInputExecutor";

// The platform-neutral half of the synthetic input executor (M2-02): given a canonical
// Action + the capture geometry, it gates on the macOS Accessibility grant, remaps the
// Action's coordinates to global logical space, and dispatches to the injected native
// backend (the thin OS edge) - Electron `clipboard` for `copy`. This is the tested core;
// the real nut.js backend is the untested edge. Everything is asserted against a fake
// backend + clipboard so no real OS input fires.

/** A geometry that maps screenshot pixels 1:1 onto a display at the origin. */
const IDENTITY_GEOMETRY: AgentDisplayGeometry = {
  bounds: { x: 0, y: 0, width: 1000, height: 800 },
  capturedWidth: 1000,
  capturedHeight: 800,
};

/** A secondary-display geometry so a dispatch test also proves the remap is applied. */
const SECONDARY_GEOMETRY: AgentDisplayGeometry = {
  bounds: { x: 1000, y: 0, width: 1000, height: 800 },
  capturedWidth: 500,
  capturedHeight: 400,
};

/** Every call the executor made to its (fake) native backend, in order. */
interface RecordedBackendCall {
  op: "click" | "moveMouse" | "typeText" | "pressKeyCombination" | "scroll";
  point?: GlobalPoint;
  text?: string;
  combo?: KeyCombination;
  direction?: ScrollDirection;
  amount?: number;
}

/** A fake native backend that records every op instead of moving real input. */
function makeFakeBackend(): { backend: NativeInputBackend; calls: RecordedBackendCall[] } {
  const calls: RecordedBackendCall[] = [];
  const backend: NativeInputBackend = {
    async click(point) {
      calls.push({ op: "click", point });
    },
    async moveMouse(point) {
      calls.push({ op: "moveMouse", point });
    },
    async typeText(text) {
      calls.push({ op: "typeText", text });
    },
    async pressKeyCombination(combo) {
      calls.push({ op: "pressKeyCombination", combo });
    },
    async scroll(direction, amount) {
      calls.push({ op: "scroll", direction, amount });
    },
  };
  return { backend, calls };
}

/** A fake clipboard that records the last text written. */
function makeFakeClipboard(): { clipboard: ClipboardWriter; written: string[] } {
  const written: string[] = [];
  return { clipboard: { writeText: (text) => written.push(text) }, written };
}

/** Boots the executor with a granted-by-default Accessibility gate and fakes. */
function bootExecutor(options?: { isAccessibilityTrusted?: () => boolean }) {
  const { backend, calls } = makeFakeBackend();
  const { clipboard, written } = makeFakeClipboard();
  const executor = createSyntheticInputExecutor({
    backend,
    clipboard,
    isAccessibilityTrusted: options?.isAccessibilityTrusted ?? (() => true),
  });
  return { executor, calls, written };
}

describe("createSyntheticInputExecutor - dispatch", () => {
  it("performs a click at the remapped global point", async () => {
    const { executor, calls } = bootExecutor();
    const action: AgentAction = { kind: "click", x: 250, y: 200, consequence: "benign" };
    await executor.execute(action, SECONDARY_GEOMETRY);
    // 250/500*1000 + 1000 = 1500; 200/400*800 = 400.
    expect(calls).toEqual([{ op: "click", point: { x: 1500, y: 400 } }]);
  });

  it("types at the current focus for a plain type (no click, no submit)", async () => {
    const { executor, calls } = bootExecutor();
    const action: AgentAction = { kind: "type", text: "hello world", consequence: "benign" };
    await executor.execute(action, IDENTITY_GEOMETRY);
    expect(calls).toEqual([{ op: "typeText", text: "hello world" }]);
  });

  it("clicks the remapped target, types, then presses Return for a compound submitting type", async () => {
    const { executor, calls } = bootExecutor();
    const action: AgentAction = {
      kind: "type",
      text: "query",
      x: 250,
      y: 200,
      pressEnter: true,
      consequence: "benign",
    };
    await executor.execute(action, SECONDARY_GEOMETRY);
    expect(calls).toEqual([
      { op: "click", point: { x: 1500, y: 400 } },
      { op: "typeText", text: "query" },
      { op: "pressKeyCombination", combo: { modifiers: [], mainKey: "return" } },
    ]);
  });

  it("presses a parsed key combination for a key Action", async () => {
    const { executor, calls } = bootExecutor();
    const action: AgentAction = { kind: "key", combo: "cmd+shift+s", consequence: "benign" };
    await executor.execute(action, IDENTITY_GEOMETRY);
    expect(calls).toEqual([
      { op: "pressKeyCombination", combo: { modifiers: ["command", "shift"], mainKey: "s" } },
    ]);
  });

  it("moves the pointer to the remapped scroll target, then scrolls", async () => {
    const { executor, calls } = bootExecutor();
    const action: AgentAction = {
      kind: "scroll",
      x: 250,
      y: 200,
      direction: "down",
      amount: 4,
      consequence: "benign",
    };
    await executor.execute(action, SECONDARY_GEOMETRY);
    expect(calls).toEqual([
      { op: "moveMouse", point: { x: 1500, y: 400 } },
      { op: "scroll", direction: "down", amount: 4 },
    ]);
  });

  it("writes a copy Action's text to the clipboard, touching no input backend", async () => {
    const { executor, calls, written } = bootExecutor();
    const action: AgentAction = { kind: "copy", text: "copied text", consequence: "benign" };
    await executor.execute(action, IDENTITY_GEOMETRY);
    expect(written).toEqual(["copied text"]);
    expect(calls).toEqual([]);
  });

  it("does nothing for observe and done (no OS effect)", async () => {
    const { executor, calls, written } = bootExecutor();
    await executor.execute({ kind: "observe", consequence: "benign" }, IDENTITY_GEOMETRY);
    await executor.execute({ kind: "done", finalText: "all set" }, IDENTITY_GEOMETRY);
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });
});

describe("createSyntheticInputExecutor - Accessibility gating", () => {
  it("throws AccessibilityNotGrantedError and performs no input when Accessibility is not granted", async () => {
    const { executor, calls, written } = bootExecutor({ isAccessibilityTrusted: () => false });
    const action: AgentAction = { kind: "click", x: 10, y: 10, consequence: "benign" };
    await expect(executor.execute(action, IDENTITY_GEOMETRY)).rejects.toBeInstanceOf(
      AccessibilityNotGrantedError,
    );
    // Never a silent no-op AND never a partial action: nothing reached the OS.
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it("does not even check the copy/no-op path against the OS when ungranted (but still refuses copy)", async () => {
    const { executor, written } = bootExecutor({ isAccessibilityTrusted: () => false });
    await expect(
      executor.execute({ kind: "copy", text: "x", consequence: "benign" }, IDENTITY_GEOMETRY),
    ).rejects.toBeInstanceOf(AccessibilityNotGrantedError);
    expect(written).toEqual([]);
  });

  it("still no-ops observe/done without requiring the grant (they touch nothing)", async () => {
    const isAccessibilityTrusted = vi.fn(() => false);
    const { executor } = bootExecutor({ isAccessibilityTrusted });
    await executor.execute({ kind: "observe", consequence: "benign" }, IDENTITY_GEOMETRY);
    await executor.execute({ kind: "done", finalText: "done" }, IDENTITY_GEOMETRY);
    // A no-op Action performs nothing, so it need not consult the permission at all.
    expect(isAccessibilityTrusted).not.toHaveBeenCalled();
  });
});

describe("parseKeyCombination", () => {
  it("splits modifiers from the main key and canonicalises modifier aliases", () => {
    expect(parseKeyCombination("cmd+s")).toEqual({ modifiers: ["command"], mainKey: "s" });
    expect(parseKeyCombination("Ctrl+Alt+Delete")).toEqual({
      modifiers: ["control", "option"],
      mainKey: "delete",
    });
    expect(parseKeyCombination("option+shift+4")).toEqual({
      modifiers: ["option", "shift"],
      mainKey: "4",
    });
  });

  it("treats a bare key as the main key with no modifiers", () => {
    expect(parseKeyCombination("return")).toEqual({ modifiers: [], mainKey: "return" });
  });

  it("tolerates spacing, casing, and empty tokens", () => {
    expect(parseKeyCombination("  CMD +  Shift +  A ")).toEqual({
      modifiers: ["command", "shift"],
      mainKey: "a",
    });
  });

  it("de-duplicates a repeated modifier and yields a null main key for a modifier-only combo", () => {
    expect(parseKeyCombination("cmd+command")).toEqual({ modifiers: ["command"], mainKey: null });
  });
});
