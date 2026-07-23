import { z } from "zod";
import { ChatInputMethodSchema } from "@lune/shared";

// The Shell's own renderer <-> main IPC for the recent-conversations dropdown (ticket
// 12). Like the Chat Panel toggle and the screen-permission channels, this is pure
// Shell plumbing: it drives the durable last-10 store, which is a platform (filesystem)
// concern the Core never sees, so it stays out of @lune/shared (the Core contract). It
// is still fully zod-typed so nothing untyped crosses the process boundary (developer
// story 46). The conversation *content* still flows over the shared chat contract; only
// the "which conversations exist / resume this one / start a new one" plumbing is here.

/**
 * Renderer -> main (invoke): the recent-conversations list plus which one is active,
 * for the dropdown. Read on panel open and whenever {@link CONVERSATIONS_CHANGED_CHANNEL}
 * fires (a turn created, renamed, or pruned a conversation).
 */
export const CONVERSATIONS_LIST_CHANNEL = "lune:conversations:list";

/**
 * Renderer -> main (invoke): resume a stored conversation by id. The main process seeds
 * the Core with its prior text history and makes it active, then resolves with that
 * history for the panel to render. The resumed turn answers with fresh screen context -
 * screenshots were never stored (ticket 12).
 */
export const CONVERSATIONS_RESUME_CHANNEL = "lune:conversations:resume";

/**
 * Renderer -> main (invoke): start a new, empty conversation. The main process resets
 * the Core's active history and mints a fresh id (persisted only once its first turn
 * completes), resolving with the new active id.
 */
export const CONVERSATIONS_NEW_CHANNEL = "lune:conversations:new";

/**
 * Main -> renderer (send): the persisted set changed (a turn completed, so a new
 * conversation appeared, a title firmed up, or the oldest was pruned). The panel
 * re-reads {@link CONVERSATIONS_LIST_CHANNEL} to refresh its dropdown.
 */
export const CONVERSATIONS_CHANGED_CHANNEL = "lune:conversations:changed";

/** One conversation as the dropdown shows it: enough to label and select, no bodies. */
export const ConversationSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  updatedAtMs: z.number(),
});
export type ConversationSummaryValue = z.infer<typeof ConversationSummarySchema>;

/** The dropdown's whole state: the recent conversations and which one is active. */
export const ConversationListSnapshotSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
  /** The active conversation's id, or `null` for a fresh one not yet persisted. */
  activeId: z.string().min(1).nullable(),
});
export type ConversationListSnapshotValue = z.infer<typeof ConversationListSnapshotSchema>;

/** One message of a resumed conversation, as the panel renders it (user turns carry the input method). */
export const ResumedMessageSchema = z.discriminatedUnion("role", [
  z.object({
    id: z.string().min(1),
    role: z.literal("user"),
    inputMethod: ChatInputMethodSchema,
    text: z.string(),
  }),
  z.object({
    id: z.string().min(1),
    role: z.literal("assistant"),
    text: z.string(),
  }),
]);

/** The result of resuming: the conversation's id and its full text history to render. */
export const ResumedConversationSchema = z.object({
  activeId: z.string().min(1),
  messages: z.array(ResumedMessageSchema),
});
export type ResumedConversationValue = z.infer<typeof ResumedConversationSchema>;
