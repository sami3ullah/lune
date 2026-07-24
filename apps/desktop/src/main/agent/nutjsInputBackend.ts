import type { ScrollDirection } from "@lune/core";
import {
  SyntheticInputUnavailableError,
  type GlobalPoint,
  type KeyCombination,
  type KeyModifier,
  type NativeInputBackend,
} from "./syntheticInputExecutor";

// The real OS input edge (M2-02): the macOS {@link NativeInputBackend} backed by the
// native `@nut-tree-fork/nut-js` module (the nut.js-class module the epic calls for),
// which posts synthetic mouse/keyboard events through the OS. It is the thin, untested
// edge - exactly like the push-to-talk hook's uiohook edge and the whisper/Kokoro node
// runtimes - so the tested executor above it drives a fake backend, and this only
// translates canonical ops into nut.js calls.
//
// The module is loaded lazily on first use (never at import), so a missing or unbuilt
// native module never blocks app startup; the load failure surfaces as a typed
// {@link SyntheticInputUnavailableError} the caller degrades on, mirroring uiohook. It
// works in global logical (point/DIP) coordinates, the same space Electron's `screen`
// reports and the executor remaps into, so points are posted unchanged.
//
// nut.js is cross-platform, but this ticket ships only the macOS path; the M7 Windows
// port supplies its own backend (or reuses this one) behind the same interface.

/** The minimal `@nut-tree-fork/nut-js` surface this backend uses (cast from the loaded module). */
interface NutJsModule {
  mouse: {
    config: { autoDelayMs: number };
    setPosition(target: unknown): Promise<unknown>;
    leftClick(): Promise<unknown>;
    scrollUp(amount: number): Promise<unknown>;
    scrollDown(amount: number): Promise<unknown>;
    scrollLeft(amount: number): Promise<unknown>;
    scrollRight(amount: number): Promise<unknown>;
  };
  keyboard: {
    config: { autoDelayMs: number };
    type(text: string): Promise<unknown>;
    pressKey(...keys: number[]): Promise<unknown>;
    releaseKey(...keys: number[]): Promise<unknown>;
  };
  Point: new (x: number, y: number) => unknown;
  /** nut.js `Key` enum as a name -> numeric-keycode record. */
  Key: Record<string, number>;
}

/** How long nut.js waits after each key event; small keeps typing snappy but reliable. */
const KEYBOARD_AUTO_DELAY_MS = 4;
/** No artificial delay between the pointer move and the click/scroll that follows it. */
const MOUSE_AUTO_DELAY_MS = 0;

/** Canonical modifier -> the nut.js `Key` name to hold for it (macOS mapping). */
const NUT_KEY_NAME_BY_MODIFIER: Readonly<Record<KeyModifier, string>> = {
  command: "LeftCmd",
  option: "LeftAlt",
  control: "LeftControl",
  shift: "LeftShift",
};

/**
 * Maps a canonical main-key token (already lowercased by `parseKeyCombination`) to a
 * nut.js `Key` name. Covers the keys the model commonly emits; an unmapped key returns
 * `undefined` and is skipped rather than pressing the wrong one. On macOS "delete" means
 * Backspace (matching v1); a forward delete is "forwarddelete".
 */
function nutKeyNameForMainKey(mainKey: string): string | undefined {
  if (/^[a-z]$/.test(mainKey)) {
    return mainKey.toUpperCase();
  }
  if (/^[0-9]$/.test(mainKey)) {
    return `Num${mainKey}`;
  }
  const namedKeys: Readonly<Record<string, string>> = {
    return: "Return",
    enter: "Return",
    tab: "Tab",
    space: "Space",
    escape: "Escape",
    esc: "Escape",
    delete: "Backspace",
    backspace: "Backspace",
    forwarddelete: "Delete",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
  };
  return namedKeys[mainKey];
}

/**
 * Resolves a nut.js `Key` name to its numeric keycode, or `undefined` when the running
 * module has no such key. Membership is checked explicitly because a valid keycode can be
 * `0` (e.g. `Escape`), so a truthiness check would wrongly drop it.
 */
function resolveNutKey(keyEnum: Record<string, number>, keyName: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(keyEnum, keyName) ? keyEnum[keyName] : undefined;
}

/**
 * Builds the macOS synthetic-input backend. The native module loads lazily and is
 * memoized; a load failure becomes a {@link SyntheticInputUnavailableError} on first use.
 */
export function createNutjsInputBackend(): NativeInputBackend {
  let modulePromise: Promise<NutJsModule> | null = null;
  let missingKeyLogged = false;

  async function loadModule(): Promise<NutJsModule> {
    if (modulePromise === null) {
      modulePromise = import("@nut-tree-fork/nut-js")
        .then((imported) => {
          const nutModule = imported as unknown as NutJsModule;
          // Teleport the pointer and keep key delays small so a multi-step run stays
          // responsive rather than crawling at nut.js's default 100-300ms per event.
          nutModule.mouse.config.autoDelayMs = MOUSE_AUTO_DELAY_MS;
          nutModule.keyboard.config.autoDelayMs = KEYBOARD_AUTO_DELAY_MS;
          return nutModule;
        })
        .catch((error) => {
          // Reset so a later attempt can retry, and surface a typed unavailable error.
          modulePromise = null;
          throw new SyntheticInputUnavailableError(error);
        });
    }
    return modulePromise;
  }

  /** Resolves the nut.js keycodes for a combination, or `null` when the main key is unmapped. */
  function resolveComboKeycodes(nutModule: NutJsModule, combo: KeyCombination): number[] | null {
    if (combo.mainKey === null) {
      return null;
    }
    const mainKeyName = nutKeyNameForMainKey(combo.mainKey);
    const mainKeycode =
      mainKeyName === undefined ? undefined : resolveNutKey(nutModule.Key, mainKeyName);
    if (mainKeycode === undefined) {
      return null;
    }
    const modifierKeycodes = combo.modifiers
      .map((modifier) => resolveNutKey(nutModule.Key, NUT_KEY_NAME_BY_MODIFIER[modifier]))
      .filter((keycode): keycode is number => keycode !== undefined);
    return [...modifierKeycodes, mainKeycode];
  }

  return {
    async click(point: GlobalPoint): Promise<void> {
      const nutModule = await loadModule();
      await nutModule.mouse.setPosition(new nutModule.Point(point.x, point.y));
      await nutModule.mouse.leftClick();
    },

    async moveMouse(point: GlobalPoint): Promise<void> {
      const nutModule = await loadModule();
      await nutModule.mouse.setPosition(new nutModule.Point(point.x, point.y));
    },

    async typeText(text: string): Promise<void> {
      const nutModule = await loadModule();
      await nutModule.keyboard.type(text);
    },

    async pressKeyCombination(combo: KeyCombination): Promise<void> {
      const nutModule = await loadModule();
      const keycodes = resolveComboKeycodes(nutModule, combo);
      if (keycodes === null) {
        // An unmapped key is skipped (not the wrong key) - log once so it is diagnosable.
        if (!missingKeyLogged) {
          console.warn(`[lune] synthetic input: no key mapping for combo`, combo);
          missingKeyLogged = true;
        }
        return;
      }
      await nutModule.keyboard.pressKey(...keycodes);
      // Release in reverse so modifiers lift after the main key, matching real typing.
      await nutModule.keyboard.releaseKey(...[...keycodes].reverse());
    },

    async scroll(direction: ScrollDirection, amount: number): Promise<void> {
      const nutModule = await loadModule();
      const magnitude = Math.max(1, Math.round(amount));
      switch (direction) {
        case "up":
          await nutModule.mouse.scrollUp(magnitude);
          return;
        case "down":
          await nutModule.mouse.scrollDown(magnitude);
          return;
        case "left":
          await nutModule.mouse.scrollLeft(magnitude);
          return;
        case "right":
          await nutModule.mouse.scrollRight(magnitude);
          return;
      }
    },
  };
}
