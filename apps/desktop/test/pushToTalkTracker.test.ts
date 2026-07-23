import { describe, expect, it } from "vitest";

import { PushToTalkTracker, type HotkeyModifierState } from "../src/main/voice/pushToTalkTracker";
import type { ParsedHotkey } from "../src/ipc/hotkey";

/**
 * Unit tests for the push-to-talk transition tracker (ticket 11) - the pure hold-to-talk
 * logic behind the voice loop, ported from v1's `BuddyPushToTalkShortcut.shortcutTransition`.
 * It emits "pressed" only when the whole chord becomes held and "released" only when it
 * stops, from a stream of normalized global key events, reading the configured chord live.
 */

/** No modifiers held (the resting flag state). */
const NO_MODIFIERS: HotkeyModifierState = { control: false, alt: false, shift: false, meta: false };

function modifiers(overrides: Partial<HotkeyModifierState>): HotkeyModifierState {
  return { ...NO_MODIFIERS, ...overrides };
}

/** A tracker over a fixed chord (the common case; a getter allows live reconfiguration). */
function trackerFor(binding: ParsedHotkey): PushToTalkTracker {
  return new PushToTalkTracker(() => binding);
}

describe("PushToTalkTracker - modifier-only chord (default ctrl+option)", () => {
  const CTRL_ALT: ParsedHotkey = { modifiers: ["control", "alt"], key: null };

  it("fires pressed only once the second modifier joins, and released when one leaves", () => {
    const tracker = trackerFor(CTRL_ALT);
    // Control down alone: half the chord, not held yet.
    expect(tracker.handle({ kind: "down", modifiers: modifiers({ control: true }), mainKey: null })).toBe(
      "none",
    );
    // Option joins: the chord is now fully held.
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, alt: true }), mainKey: null }),
    ).toBe("pressed");
    // Option released: the chord breaks.
    expect(tracker.handle({ kind: "up", modifiers: modifiers({ control: true }), mainKey: null })).toBe(
      "released",
    );
    // Control released: nothing more to release.
    expect(tracker.handle({ kind: "up", modifiers: NO_MODIFIERS, mainKey: null })).toBe("none");
  });

  it("does not re-fire pressed while the chord stays held (e.g. an unrelated key press)", () => {
    const tracker = trackerFor(CTRL_ALT);
    tracker.handle({ kind: "down", modifiers: modifiers({ control: true }), mainKey: null });
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, alt: true }), mainKey: null }),
    ).toBe("pressed");
    // A benign key pressed while the chord is held keeps modifiers set: still held, no re-fire.
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, alt: true }), mainKey: "B" }),
    ).toBe("none");
  });

  it("still matches when an extra modifier is held alongside (superset, like v1)", () => {
    const tracker = trackerFor(CTRL_ALT);
    // Shift is also down; the chord's two modifiers are present, so it counts as held.
    expect(
      tracker.handle({
        kind: "down",
        modifiers: modifiers({ control: true, alt: true, shift: true }),
        mainKey: null,
      }),
    ).toBe("pressed");
  });

  it("orders press/release by whichever modifier completes or breaks the chord", () => {
    const tracker = trackerFor(CTRL_ALT);
    // Option first this time, then control completes it.
    expect(tracker.handle({ kind: "down", modifiers: modifiers({ alt: true }), mainKey: null })).toBe("none");
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, alt: true }), mainKey: null }),
    ).toBe("pressed");
    // Dropping control breaks it even though option is still down.
    expect(tracker.handle({ kind: "up", modifiers: modifiers({ alt: true }), mainKey: null })).toBe(
      "released",
    );
  });
});

describe("PushToTalkTracker - chord with a main key (e.g. ctrl+shift+Space)", () => {
  const CTRL_SHIFT_SPACE: ParsedHotkey = { modifiers: ["control", "shift"], key: "Space" };

  it("fires pressed only when both modifiers and the main key are held", () => {
    const tracker = trackerFor(CTRL_SHIFT_SPACE);
    // Both modifiers down, but no Space yet: not held.
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, shift: true }), mainKey: null }),
    ).toBe("none");
    // Space down with the modifiers: held.
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, shift: true }), mainKey: "Space" }),
    ).toBe("pressed");
    // Space up: released (releasing the main key ends the chord).
    expect(
      tracker.handle({ kind: "up", modifiers: modifiers({ control: true, shift: true }), mainKey: "Space" }),
    ).toBe("released");
  });

  it("releases when a modifier drops even though the main key is still down", () => {
    const tracker = trackerFor(CTRL_SHIFT_SPACE);
    tracker.handle({ kind: "down", modifiers: modifiers({ control: true, shift: true }), mainKey: "Space" });
    // Shift released while Space still held: chord breaks.
    expect(tracker.handle({ kind: "up", modifiers: modifiers({ control: true }), mainKey: null })).toBe(
      "released",
    );
  });

  it("ignores an unrelated main key's up while the real main key is held", () => {
    const tracker = trackerFor(CTRL_SHIFT_SPACE);
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, shift: true }), mainKey: "Space" }),
    ).toBe("pressed");
    // Some other key releasing must not clear the held Space (a different key's up is noise).
    expect(
      tracker.handle({ kind: "up", modifiers: modifiers({ control: true, shift: true }), mainKey: "K" }),
    ).toBe("none");
  });
});

describe("PushToTalkTracker.reset and live reconfiguration", () => {
  it("clears held state so a key-up missed during a hook restart cannot wedge the chord", () => {
    const tracker = trackerFor({ modifiers: ["control", "alt"], key: null });
    tracker.handle({ kind: "down", modifiers: modifiers({ control: true, alt: true }), mainKey: null });
    tracker.reset();
    // After reset, the same still-held modifiers read as a fresh press, not a stuck "held".
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, alt: true }), mainKey: null }),
    ).toBe("pressed");
  });

  it("reads the binding live, so a Settings edit changes what counts as the chord", () => {
    let binding: ParsedHotkey = { modifiers: ["control", "alt"], key: null };
    const tracker = new PushToTalkTracker(() => binding);
    // ctrl+option holds under the first binding.
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ control: true, alt: true }), mainKey: null }),
    ).toBe("pressed");
    // The user changes the hotkey to shift+meta; ctrl+option no longer qualifies.
    binding = { modifiers: ["shift", "meta"], key: null };
    expect(tracker.handle({ kind: "up", modifiers: modifiers({ control: true }), mainKey: null })).toBe(
      "released",
    );
    expect(
      tracker.handle({ kind: "down", modifiers: modifiers({ shift: true, meta: true }), mainKey: null }),
    ).toBe("pressed");
  });
});
