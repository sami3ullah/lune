// The push-to-talk hotkey editor logic (ticket 13): the pure parse/validate/format
// helpers the Settings hotkey editor uses, operating on the "+"-joined token string
// the Shell persists (e.g. "control+alt"). It is dependency-free (no Electron, no
// Node), so it lives here in `ipc/` alongside the settings contract and is shared by
// both the main process (validating a save) and the renderer (the editor's live
// display + validation) - the renderer never reaches into `main/`. The push-to-talk
// voice loop (ticket 11) maps the token to real key matching; this ticket owns the
// editor, so the token is already a validated, canonical shape by then.
//
// A token is a set of held modifiers plus an optional main key. The default is the
// modifier-only chord ctrl+option (spec: default push-to-talk = ctrl+option), held
// while speaking. Parsing (reading a persisted/edited token) tolerates loose input;
// validation (accepting an edit) is strict and explains any rejection, so the editor
// can reject a bad combo gracefully rather than silently dropping it.

/** The modifiers a hotkey can require, in the canonical order they are ordered/displayed. */
export const HOTKEY_MODIFIERS = ["control", "alt", "shift", "meta"] as const;
export type HotkeyModifier = (typeof HOTKEY_MODIFIERS)[number];

const HOTKEY_MODIFIER_SET: ReadonlySet<string> = new Set(HOTKEY_MODIFIERS);

/** The default push-to-talk token: hold ctrl+option and speak (spec default, v1 verbatim). */
export const DEFAULT_HOTKEY_TOKEN = "control+alt";

/** How each modifier is shown to the user (macOS names in M1). */
const MODIFIER_DISPLAY_NAMES: Record<HotkeyModifier, string> = {
  control: "ctrl",
  alt: "option",
  shift: "shift",
  meta: "cmd",
};

/** A hotkey broken into its parts: the held modifiers and an optional main key. */
export interface ParsedHotkey {
  modifiers: HotkeyModifier[];
  /** The main key (e.g. "Space", "A", "F5"), or `null` for a modifier-only chord. */
  key: string | null;
}

/**
 * Normalizes a candidate main key to its canonical token, or `null` when it is empty
 * or unsupported. Letters/digits upper-case; "Space" and F1-F12 are canonical as
 * written. A single main key is optional (modifier-only chords are the default).
 */
function normalizeMainKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  if (/^[A-Z0-9]$/.test(upper)) {
    return upper;
  }
  if (upper === "SPACE") {
    return "Space";
  }
  if (/^F([1-9]|1[0-2])$/.test(upper)) {
    return upper;
  }
  return null;
}

/** Sorts + de-duplicates modifiers into the canonical order. */
function canonicalModifiers(modifiers: readonly HotkeyModifier[]): HotkeyModifier[] {
  const present = new Set(modifiers);
  return HOTKEY_MODIFIERS.filter((modifier) => present.has(modifier));
}

/**
 * Parses a token string into its parts, or `null` when it is not a hotkey token at all
 * (empty, or every segment unrecognized). Recognized modifier segments become
 * modifiers; the first recognized non-modifier segment becomes the main key. Case- and
 * order-insensitive; an unrecognized segment makes the whole token unparseable so a
 * typo never silently becomes a different binding.
 */
export function parseHotkeyToken(token: string): ParsedHotkey | null {
  if (typeof token !== "string") {
    return null;
  }
  const segments = token
    .split("+")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }

  const modifiers: HotkeyModifier[] = [];
  let key: string | null = null;
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (HOTKEY_MODIFIER_SET.has(lower)) {
      modifiers.push(lower as HotkeyModifier);
      continue;
    }
    const mainKey = normalizeMainKey(segment);
    if (mainKey === null || key !== null) {
      // An unrecognized segment, or a second main key, makes the token invalid.
      return null;
    }
    key = mainKey;
  }

  return { modifiers: canonicalModifiers(modifiers), key };
}

/** Renders parsed parts back into a canonical token string, e.g. "control+alt+Space". */
export function formatHotkeyToken(parsed: ParsedHotkey): string {
  const parts: string[] = canonicalModifiers(parsed.modifiers);
  if (parsed.key !== null) {
    parts.push(parsed.key);
  }
  return parts.join("+");
}

/** The result of validating a candidate token the editor is about to persist. */
export type HotkeyValidation = { ok: true; token: string } | { ok: false; reason: string };

/**
 * Validates a candidate token for the editor, returning either the canonical token to
 * persist or a short human-readable reason it was rejected (acceptance: "conflicts /
 * invalid combos rejected gracefully").
 *
 * The rules keep a hotkey from colliding with ordinary typing: a modifier-only chord
 * needs at least two modifiers (a lone modifier fires constantly), and a chord with a
 * main key needs at least one modifier (a bare key would trigger mid-sentence).
 */
export function validateHotkeyToken(token: string): HotkeyValidation {
  const parsed = parseHotkeyToken(token);
  if (parsed === null) {
    return { ok: false, reason: `Unsupported hotkey: ${token}` };
  }
  if (parsed.key === null) {
    if (parsed.modifiers.length < 2) {
      return { ok: false, reason: "A modifier-only hotkey needs at least two modifiers" };
    }
  } else if (parsed.modifiers.length < 1) {
    return { ok: false, reason: "A hotkey with a key needs at least one modifier" };
  }
  return { ok: true, token: formatHotkeyToken(parsed) };
}

/**
 * The canonical token for a persisted/edited value, falling back to the default when it
 * is invalid - so a hand-edited or future config never leaves the app with no
 * push-to-talk key. (The Core config layer also defaults a blank string; this adds the
 * editor's stricter rules on top.)
 */
export function canonicalHotkeyToken(token: string): string {
  const validation = validateHotkeyToken(token);
  return validation.ok ? validation.token : DEFAULT_HOTKEY_TOKEN;
}

/** A human-readable rendering of a token for the editor, e.g. "ctrl + option". */
export function displayHotkeyToken(token: string): string {
  const parsed = parseHotkeyToken(token);
  if (parsed === null) {
    return token;
  }
  const parts = canonicalModifiers(parsed.modifiers).map((modifier) => MODIFIER_DISPLAY_NAMES[modifier]);
  if (parsed.key !== null) {
    parts.push(parsed.key);
  }
  return parts.join(" + ");
}
