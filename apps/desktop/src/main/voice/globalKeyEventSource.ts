import type { PushToTalkKeyEvent } from "./pushToTalkTracker";
import {
  subscribeGlobalInput,
  type UiohookKeyboardEvent,
  type UiohookModuleSurface,
} from "../input/globalInputHook";

// The platform edge that feeds the push-to-talk tracker (ticket 11): a system-wide
// keyboard hook that reports key down/up while any app has focus, so hold-to-talk works
// everywhere - not just when Lune is focused. It is the thin, untested edge (the tracker
// and the voice-loop machine it drives are the tested core), and it sits behind a small
// interface so the M7 Windows port swaps the implementation without touching the loop.
//
// macOS/Windows/Linux global key capture has no first-class Electron API (globalShortcut
// fires on an accelerator, never a modifier-only hold, and never a release), so this
// rides the shared `uiohook-napi` hook ({@link subscribeGlobalInput}) - the successor of
// v1's listen-only CGEvent tap, shared with the overlay's scroll dismissal so the one
// native event tap is started and stopped in exactly one place. It loads lazily and
// degrades gracefully: if the native module is unavailable (or the OS withholds Input
// Monitoring), push-to-talk is simply inactive rather than crashing the app, exactly
// like whisper being not-yet-provisioned.

/** A system-wide source of normalized key events for the push-to-talk tracker. */
export interface GlobalKeyEventSource {
  /** Begins delivering key events to `handler`. Safe to call once; a second call is ignored. */
  start(handler: (event: PushToTalkKeyEvent) => void): void;
  /** Stops delivering events and releases the OS hook. Safe to call when not started. */
  stop(): void;
}

/** The main keys the hotkey grammar accepts (mirrors `ipc/hotkey`'s `normalizeMainKey`). */
const ACCEPTED_MAIN_KEY = /^([A-Z0-9]|Space|F([1-9]|1[0-2]))$/;

/**
 * Builds a keycode -> canonical-token map for the non-modifier keys the hotkey grammar
 * accepts. A modifier keycode is deliberately absent, so a modifier keydown maps to a
 * `null` main key (its state is read from the event's modifier flags instead).
 */
function buildMainKeyByKeycode(uiohookKey: Record<string, number>): Map<number, string> {
  const mainKeyByKeycode = new Map<number, string>();
  for (const [name, keycode] of Object.entries(uiohookKey)) {
    if (ACCEPTED_MAIN_KEY.test(name)) {
      mainKeyByKeycode.set(keycode, name);
    }
  }
  return mainKeyByKeycode;
}

/**
 * The production key source, backed by the shared `uiohook-napi` global hook. If the
 * native module fails to load, {@link GlobalKeyEventSource.start} stays a no-op (the
 * shared hook logs once).
 */
export function createUiohookKeyEventSource(): GlobalKeyEventSource {
  let unsubscribe: (() => void) | null = null;

  function toKeyEvent(
    kind: "down" | "up",
    rawEvent: UiohookKeyboardEvent,
    mainKeyByKeycode: Map<number, string>,
  ): PushToTalkKeyEvent {
    return {
      kind,
      modifiers: {
        control: rawEvent.ctrlKey,
        alt: rawEvent.altKey,
        shift: rawEvent.shiftKey,
        meta: rawEvent.metaKey,
      },
      mainKey: mainKeyByKeycode.get(rawEvent.keycode) ?? null,
    };
  }

  return {
    start(handler: (event: PushToTalkKeyEvent) => void): void {
      if (unsubscribe !== null) {
        return;
      }
      unsubscribe = subscribeGlobalInput((module: UiohookModuleSurface) => {
        const mainKeyByKeycode = buildMainKeyByKeycode(module.UiohookKey);
        return {
          keydown: (rawEvent) => handler(toKeyEvent("down", rawEvent, mainKeyByKeycode)),
          keyup: (rawEvent) => handler(toKeyEvent("up", rawEvent, mainKeyByKeycode)),
        };
      });
    },

    stop(): void {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
}
