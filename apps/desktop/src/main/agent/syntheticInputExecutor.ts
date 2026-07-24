import type { AgentAction, ScrollDirection } from "@lune/core";
import {
  remapActionToGlobalSpace,
  type AgentDisplayGeometry,
  type GlobalPoint,
} from "./agentCoordinateRemap";

export type { GlobalPoint } from "./agentCoordinateRemap";
export type { ScrollDirection } from "@lune/core";

// The Shell's hands (M2-02): the platform-neutral executor that performs one canonical
// Action as real OS input. It is the successor of v1's `SnappyAgentActionExecutor` +
// `SnappyAgentRemappingExecutor`, folded into one seam: gate on the macOS Accessibility
// grant, remap the Action's screenshot-space coordinates to global logical space
// (`agentCoordinateRemap`), then dispatch to the injected native backend - Electron's
// `clipboard` for `copy`.
//
// The tested core is here (dispatch + gating, proven against a fake backend). The real
// OS input is the thin, untested edge behind {@link NativeInputBackend} - a native
// module (`nutjsInputBackend`), exactly like the push-to-talk hook's uiohook edge. That
// interface is also the platform seam: the M7 Windows port supplies another backend
// without touching this dispatch logic.

/** The canonical set of modifier keys a key combination can carry. */
export type KeyModifier = "command" | "option" | "control" | "shift";

/** A parsed key combination: its modifiers plus the single non-modifier key (if any). */
export interface KeyCombination {
  modifiers: KeyModifier[];
  /** The non-modifier key token (e.g. `"s"`, `"return"`), or `null` for a modifier-only combo. */
  mainKey: string | null;
}

/**
 * The low-level OS input operations, in global logical (point/DIP) coordinates. This is
 * the platform edge: the macOS implementation drives a native module; a Windows one is a
 * drop-in for M7. Coordinates are already remapped to global space by the executor, so a
 * backend just posts them.
 */
export interface NativeInputBackend {
  /** Move the pointer to `point` and click the primary mouse button. */
  click(point: GlobalPoint): Promise<void>;
  /** Move the pointer to `point` without clicking (e.g. before a scroll). */
  moveMouse(point: GlobalPoint): Promise<void>;
  /** Type a Unicode string wherever the OS focus currently is. */
  typeText(text: string): Promise<void>;
  /** Press a key combination (modifiers held while the main key is tapped). */
  pressKeyCombination(combo: KeyCombination): Promise<void>;
  /** Scroll the content under the pointer by a backend-interpreted amount. */
  scroll(direction: ScrollDirection, amount: number): Promise<void>;
}

/** Writes text to the system clipboard - the `copy` Action's effect (no synthetic event). */
export interface ClipboardWriter {
  writeText(text: string): void;
}

/** The executor the Screen Agent loop drives: perform one Action against one capture. */
export interface SyntheticInputExecutor {
  /**
   * Performs `action` as real OS input. `action`'s coordinates are in the capture's
   * screenshot-pixel space; `geometry` is that capture's display geometry, used to remap
   * them to global logical space. Throws {@link AccessibilityNotGrantedError} - before
   * touching any input - when macOS Accessibility is not granted, so the caller can route
   * the user to the Accessibility pane rather than silently doing nothing. `observe` and
   * `done` have no OS effect and perform nothing (they never require the grant).
   */
  execute(action: AgentAction, geometry: AgentDisplayGeometry): Promise<void>;
}

/**
 * Thrown when a Screen Agent run reaches the executor without the macOS Accessibility
 * grant. Accessibility is granted in M1 onboarding (the push-to-talk hook needs it), so
 * this is the rare degrade path: rather than a silent no-op, the executor refuses and the
 * caller routes the user to System Settings › Privacy & Security › Accessibility
 * (acceptance #3). The message is user-facing.
 */
export class AccessibilityNotGrantedError extends Error {
  constructor() {
    super(
      "Lune needs Accessibility permission to control your computer. Enable Lune in System Settings > Privacy & Security > Accessibility, then try again.",
    );
    this.name = "AccessibilityNotGrantedError";
  }
}

/**
 * Thrown when the native input backend cannot be loaded (the native module is missing or
 * failed to build), so synthetic input is unavailable this run. Separate from the
 * Accessibility case: nothing the user can grant fixes it, so the caller surfaces it as a
 * plain "acting unavailable" rather than routing to a permission pane. The backend module
 * raises it lazily on first use.
 */
export class SyntheticInputUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Synthetic input is unavailable: the native input module could not be loaded.");
    this.name = "SyntheticInputUnavailableError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Modifier token aliases (as the model may emit them) -> the canonical modifier. */
const MODIFIER_BY_ALIAS: Readonly<Record<string, KeyModifier>> = {
  cmd: "command",
  command: "command",
  meta: "command",
  super: "command",
  win: "command",
  opt: "option",
  option: "option",
  alt: "option",
  ctrl: "control",
  control: "control",
  shift: "shift",
};

/**
 * Parses a key-combo string (e.g. `"cmd+s"`, `"ctrl+alt+delete"`, `"return"`) into its
 * canonical modifiers and single main key. Tolerant of spacing, casing, and empty tokens;
 * de-duplicates modifiers; the last non-modifier token wins as the main key (a
 * modifier-only combo yields a `null` main key). Pure, so the parsing is unit-tested apart
 * from the native key mapping the backend applies.
 */
export function parseKeyCombination(combo: string): KeyCombination {
  const tokens = combo
    .toLowerCase()
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const modifiers: KeyModifier[] = [];
  let mainKey: string | null = null;
  for (const token of tokens) {
    const modifier = MODIFIER_BY_ALIAS[token];
    if (modifier !== undefined) {
      if (!modifiers.includes(modifier)) {
        modifiers.push(modifier);
      }
    } else {
      mainKey = token;
    }
  }
  return { modifiers, mainKey };
}

/** The Action kinds that have no OS effect, so they never require the Accessibility grant. */
function isNoOpAction(action: AgentAction): boolean {
  return action.kind === "observe" || action.kind === "done";
}

export interface SyntheticInputExecutorDependencies {
  /** The OS input edge (production: a native module; tests: a fake). */
  backend: NativeInputBackend;
  /** Writes the `copy` Action's text to the clipboard (production: Electron `clipboard`). */
  clipboard: ClipboardWriter;
  /**
   * Whether this process is a trusted macOS Accessibility client right now, read without
   * prompting. Read on every executed Action so a mid-run revocation is caught (and so a
   * revoked grant degrades cleanly rather than posting events into the void).
   */
  isAccessibilityTrusted: () => boolean;
}

export function createSyntheticInputExecutor(
  dependencies: SyntheticInputExecutorDependencies,
): SyntheticInputExecutor {
  const { backend, clipboard, isAccessibilityTrusted } = dependencies;

  async function execute(action: AgentAction, geometry: AgentDisplayGeometry): Promise<void> {
    // A no-op Action changes nothing on screen, so it neither needs the grant nor touches
    // the OS - return before gating so `observe`/`done` are always safe.
    if (isNoOpAction(action)) {
      return;
    }

    // Gate every effecting Action on the Accessibility grant. Refusing loudly (rather than
    // a silent no-op) is what lets the caller route the user to the Accessibility pane.
    if (!isAccessibilityTrusted()) {
      throw new AccessibilityNotGrantedError();
    }

    const remapped = remapActionToGlobalSpace(action, geometry);
    switch (remapped.kind) {
      case "click": {
        await backend.click({ x: remapped.x, y: remapped.y });
        return;
      }
      case "type": {
        // A compound type clicks its target first; a focus-typing type has no target.
        if (remapped.x !== undefined && remapped.y !== undefined) {
          await backend.click({ x: remapped.x, y: remapped.y });
        }
        await backend.typeText(remapped.text);
        if (remapped.pressEnter === true) {
          await backend.pressKeyCombination({ modifiers: [], mainKey: "return" });
        }
        return;
      }
      case "key": {
        await backend.pressKeyCombination(parseKeyCombination(remapped.combo));
        return;
      }
      case "scroll": {
        // Move the pointer to the scroll target first so the event lands on the right view.
        await backend.moveMouse({ x: remapped.x, y: remapped.y });
        await backend.scroll(remapped.direction, remapped.amount);
        return;
      }
      case "copy": {
        clipboard.writeText(remapped.text);
        return;
      }
      default:
        // `observe`/`done` were handled above; this is unreachable but keeps the switch
        // exhaustive so a new Action kind is a compile error, not a silent skip.
        return;
    }
  }

  return { execute };
}
