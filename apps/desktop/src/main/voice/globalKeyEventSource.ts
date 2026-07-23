import type { PushToTalkKeyEvent } from "./pushToTalkTracker";

// The platform edge that feeds the push-to-talk tracker (ticket 11): a system-wide
// keyboard hook that reports key down/up while any app has focus, so hold-to-talk works
// everywhere - not just when Lune is focused. It is the thin, untested edge (the tracker
// and the voice-loop machine it drives are the tested core), and it sits behind a small
// interface so the M7 Windows port swaps the implementation without touching the loop.
//
// macOS/Windows/Linux global key capture has no first-class Electron API (globalShortcut
// fires on an accelerator, never a modifier-only hold, and never a release), so this
// uses the native `uiohook-napi` hook - the successor of v1's listen-only CGEvent tap.
// It loads lazily and degrades gracefully: if the native module is unavailable (or the
// OS withholds Input Monitoring), push-to-talk is simply inactive rather than crashing
// the app, exactly like whisper being not-yet-provisioned.

/** A system-wide source of normalized key events for the push-to-talk tracker. */
export interface GlobalKeyEventSource {
  /** Begins delivering key events to `handler`. Safe to call once; a second call is ignored. */
  start(handler: (event: PushToTalkKeyEvent) => void): void;
  /** Stops delivering events and releases the OS hook. Safe to call when not started. */
  stop(): void;
}

/** The subset of a `uiohook-napi` keyboard event this module reads. */
interface UiohookKeyboardEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

type UiohookKeyboardListener = (event: UiohookKeyboardEvent) => void;

/** The subset of the `uiohook-napi` module surface this module uses. */
interface UiohookModule {
  uIOhook: {
    on(eventName: "keydown" | "keyup", listener: UiohookKeyboardListener): void;
    removeListener(eventName: "keydown" | "keyup", listener: UiohookKeyboardListener): void;
    start(): void;
    stop(): void;
  };
  UiohookKey: Record<string, number>;
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
 * The production key source, backed by the native `uiohook-napi` global hook. Loaded
 * lazily so a missing/broken native module never blocks the app from starting; if the
 * load fails, {@link GlobalKeyEventSource.start} logs once and stays a no-op.
 */
export function createUiohookKeyEventSource(): GlobalKeyEventSource {
  let loadedModule: UiohookModule | null = null;
  let keydownListener: UiohookKeyboardListener | null = null;
  let keyupListener: UiohookKeyboardListener | null = null;
  let started = false;

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
      if (started) {
        return;
      }
      started = true;
      // Load the native hook asynchronously so a slow/failed load never blocks startup.
      void import("uiohook-napi")
        .then((imported) => {
          if (!started) {
            // stop() was called before the module finished loading; do not attach.
            return;
          }
          const uiohookModule = imported as unknown as UiohookModule;
          loadedModule = uiohookModule;
          const mainKeyByKeycode = buildMainKeyByKeycode(uiohookModule.UiohookKey);

          keydownListener = (rawEvent) => handler(toKeyEvent("down", rawEvent, mainKeyByKeycode));
          keyupListener = (rawEvent) => handler(toKeyEvent("up", rawEvent, mainKeyByKeycode));
          uiohookModule.uIOhook.on("keydown", keydownListener);
          uiohookModule.uIOhook.on("keyup", keyupListener);
          uiohookModule.uIOhook.start();
        })
        .catch((error) => {
          started = false;
          console.error(
            "[lune] global push-to-talk hook unavailable; hold-to-talk is disabled:",
            error,
          );
        });
    },

    stop(): void {
      started = false;
      const uiohookModule = loadedModule;
      if (uiohookModule === null) {
        return;
      }
      if (keydownListener !== null) {
        uiohookModule.uIOhook.removeListener("keydown", keydownListener);
        keydownListener = null;
      }
      if (keyupListener !== null) {
        uiohookModule.uIOhook.removeListener("keyup", keyupListener);
        keyupListener = null;
      }
      try {
        uiohookModule.uIOhook.stop();
      } catch (error) {
        console.error("[lune] failed to stop the global push-to-talk hook:", error);
      }
      loadedModule = null;
    },
  };
}
