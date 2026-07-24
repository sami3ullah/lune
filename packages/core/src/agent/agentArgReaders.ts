/**
 * Small shared coercers that read a value out of a Vendor's untyped function/tool
 * arguments (`Record<string, unknown>`) into the type a canonical Action needs,
 * defaulting rather than throwing on anything malformed. Both the Anthropic and
 * Gemini computer-use adapters translate untrusted Vendor arguments, so these live
 * here rather than being copied into each adapter.
 *
 * Carried from v1's Sidecar (`agent/agentArgReaders.ts`), unchanged.
 */
import type { ScrollDirection } from "./agentAction.js";

/** Reads a string argument, defaulting to empty when absent or the wrong type. */
export function readStringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reads a finite-number argument, defaulting to 0 when absent or the wrong type. */
export function readNumberArg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reads a scroll direction, defaulting to `down` on any unrecognised value. */
export function readScrollDirectionArg(value: unknown): ScrollDirection {
  if (value === "up" || value === "down" || value === "left" || value === "right") {
    return value;
  }
  return "down";
}

/**
 * Reads a key combination, accepting either a `"ctrl+c"` string (as-is) or an array of
 * keys joined with `+` (e.g. `["cmd", "s"] -> "cmd+s"`). Vendors express key presses
 * both ways (Gemini's `key_combination`, OpenAI's `keypress`), so the coercion is shared.
 */
export function readKeyComboArg(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((key): key is string => typeof key === "string").join("+");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}
