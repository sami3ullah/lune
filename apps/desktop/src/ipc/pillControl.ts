import { z } from "zod";

// The Shell's own renderer <-> main IPC, kept separate from @lune/shared. That
// package is the Shell<->Core contract - messages that reach the Core (and, later,
// an HTTP adapter fronting it). These pill-control messages never touch the Core:
// they are pure window plumbing (resize the frameless window to its content, quit
// the app) that a future HTTP adapter would never carry. Keeping them here leaves
// the Core contract honest while still typing every message that crosses the
// process boundary with a shared zod schema (developer story 46).

/**
 * Renderer -> main: the pill's rendered content changed size (it expanded into its
 * hover menu, or collapsed back to the bar). The main process resizes the frameless
 * window to match exactly so no invisible region is left to swallow clicks meant for
 * the apps behind it. Sizes are logical pixels measured in the renderer.
 */
export const PILL_RESIZE_CHANNEL = "lune:pill:resize";

export const PillContentSizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
export type PillContentSize = z.infer<typeof PillContentSizeSchema>;

/**
 * Renderer -> main: quit Lune from the pill menu. A fire-and-forget signal with no
 * payload; the main process tears the app down cleanly (developer story 41 - the
 * whisper child process teardown joins this path when that Capability lands).
 */
export const APP_QUIT_CHANNEL = "lune:app:quit";
