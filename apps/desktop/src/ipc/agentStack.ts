import { z } from "zod";

// The Shell's own renderer <-> main IPC for the Agent Stack surface (M5-03), kept separate
// from @lune/shared for the same reason as pill-control and overlay-control: these messages
// are pure window plumbing that never reaches the Core. A future HTTP adapter would carry the
// Task Agent event stream (that contract lives in @lune/shared), but "resize the stack
// window", "open this result", and "list the current cards to seed the surface" are Shell
// concerns. They stay out of the Core contract but are still fully zod-typed so nothing
// untyped crosses the process boundary.
//
// The live Task Agent event stream itself, and the start/cancel commands, use the
// @lune/shared contract (TASK_AGENT_* channels); this module only adds the surface plumbing
// around it.

/**
 * The renderer-route hash the main process loads the Agent Stack window with. Every window
 * runs the same renderer bundle and branches on the hash (matching `#chat`, `#overlay`, ...).
 */
export const AGENT_STACK_ROUTE_HASH = "agentStack";

/**
 * renderer -> main (send): the Agent Stack reports its rendered content size and how many
 * cards it is showing, so the main process can size the frameless window to match exactly
 * (top-right, growing downward) and hide it when the last card is dismissed.
 */
export const AGENT_STACK_CONTENT_SIZE_CHANNEL = "lune:agent-stack:resize";

/**
 * renderer -> main (send): open a finished agent's produced artifact in the OS - reveal/open
 * a file, or open a URL in the browser. A plain text summary is not an OS artifact; the
 * surface reads it in place (expanding the card), so it never crosses this channel.
 */
export const AGENT_STACK_OPEN_RESULT_CHANNEL = "lune:agent-stack:open-result";

/**
 * renderer -> main (invoke): read the current snapshot of every Task Agent session, so the
 * surface can seed its cards on mount (a window opened after agents started, or re-opened,
 * still shows them). The live stream (@lune/shared TASK_AGENT_EVENT_CHANNEL) updates from
 * there. Mirrors how the Chat Panel seeds from `conversations.active()` then streams.
 */
export const AGENT_STACK_SNAPSHOTS_CHANNEL = "lune:agent-stack:snapshots";

/** The Agent Stack's rendered content size plus its live card count. */
export const AgentStackContentSizeSchema = z.object({
  /** The rendered width in logical pixels. */
  width: z.number().nonnegative(),
  /** The rendered height in logical pixels. */
  height: z.number().nonnegative(),
  /** How many cards are showing; 0 means the surface is empty and the window should hide. */
  cardCount: z.number().int().nonnegative(),
});
export type AgentStackContentSize = z.infer<typeof AgentStackContentSizeSchema>;

/**
 * What "open the result" means for a finished agent when there's an OS artifact to open, as
 * decided by the renderer's result classifier: open a file or open a URL. (A plain summary is
 * read in place on the card, so it isn't part of this union.)
 */
export const OpenAgentResultRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  z.object({ kind: z.literal("url"), url: z.string().min(1) }),
]);
export type OpenAgentResultRequest = z.infer<typeof OpenAgentResultRequestSchema>;
