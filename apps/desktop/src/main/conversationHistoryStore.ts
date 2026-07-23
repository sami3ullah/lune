import { z } from "zod";
import { ChatInputMethodSchema } from "@lune/shared";
import type { ConversationMessage } from "@lune/core";

// The durable last-10 conversation store (ticket 12). Persistence is a platform
// concern - it touches the real filesystem under the app's userData - so it lives in
// the Shell behind a small injected fs seam (the same shape as PillPositionStore and
// the routing config store), keeping the Core pure and transport-agnostic. The Core
// owns the *active* conversation's turn logic; this owns the durable *set*: the last 10
// conversations, text only (never audio, never screenshots), oldest auto-pruned.
//
// "Text only" is guaranteed by construction, not by scrubbing: the persisted shape is
// exactly the Core's {@link ConversationMessage} (id, role, text, and - on user turns -
// the input method), which has no field for a screenshot or an audio clip. Screen
// captures are handed straight to the in-process Core and never enter this history; a
// resumed conversation begins with fresh screen context by design.

/** The most conversations kept; saving an 11th silently evicts the oldest. */
export const MAX_CONVERSATIONS = 10;

/** How long a derived dropdown title may be before it is truncated. */
const MAX_TITLE_LENGTH = 60;

/** Shown for a conversation with no user text yet (a brand-new, unsent one). */
const EMPTY_TITLE = "New conversation";

/**
 * One persisted message, validated on load so a hand-edited or partially-written file
 * can never seed the Core with a malformed turn. Mirrors {@link ConversationMessage}
 * exactly: user turns carry the input method, assistant replies do not.
 */
const StoredMessageSchema = z.discriminatedUnion("role", [
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

const StoredConversationSchema = z.object({
  id: z.string().min(1),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  messages: z.array(StoredMessageSchema),
});

/** The on-disk document: a version tag (so a future migration is unambiguous) + the set. */
const StoreDocumentSchema = z.object({
  version: z.literal(1),
  conversations: z.array(StoredConversationSchema),
});

const STORE_VERSION = 1;

/** One durably-stored conversation: its identity, timestamps, and text-only history. */
export type StoredConversation = z.infer<typeof StoredConversationSchema>;

/** The dropdown's view of a conversation: enough to label and select it, no message bodies. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAtMs: number;
}

/** Reads the persisted store file's raw contents, or throws if it is absent. */
export type ReadStoreFile = (filePath: string) => string;

/** Writes the persisted store file's contents (best-effort). */
export type WriteStoreFile = (filePath: string, contents: string) => void;

/**
 * Keeps at most `cap` conversations, evicting the oldest by last-update time. Pure and
 * exported so the eviction rule is unit-tested directly (ticket 12 acceptance). Sorting
 * by `updatedAtMs` means an old conversation the user just resumed is kept, and a stale
 * one is dropped - "oldest" is least-recently-active, not first-created.
 */
export function pruneToCap(
  conversations: StoredConversation[],
  cap: number,
): StoredConversation[] {
  if (conversations.length <= cap) {
    return conversations;
  }
  return [...conversations]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, cap);
}

/**
 * A short, human-readable label for the dropdown, taken from the conversation's first
 * user turn (truncated), or a placeholder when it has no user text yet.
 */
export function deriveConversationTitle(messages: ConversationMessage[]): string {
  const firstUserText = messages.find((message) => message.role === "user")?.text.trim();
  if (firstUserText === undefined || firstUserText.length === 0) {
    return EMPTY_TITLE;
  }
  if (firstUserText.length <= MAX_TITLE_LENGTH) {
    return firstUserText;
  }
  return `${firstUserText.slice(0, MAX_TITLE_LENGTH).trimEnd()}...`;
}

export class ConversationHistoryStore {
  // Loaded once at construction and kept in memory; this process is the only writer, so
  // the file is a persistence mirror rather than a source re-read on every access.
  private conversations: StoredConversation[];

  constructor(
    private readonly filePath: string,
    private readonly readFile: ReadStoreFile,
    private readonly writeFile: WriteStoreFile,
    private readonly now: () => number,
  ) {
    this.conversations = this.load();
  }

  /**
   * The persisted conversations as dropdown summaries, newest (most recently updated)
   * first - so the Chat Panel's recent-conversations list needs no further sorting.
   */
  list(): ConversationSummary[] {
    return [...this.conversations]
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .map((conversation) => ({
        id: conversation.id,
        title: deriveConversationTitle(conversation.messages),
        updatedAtMs: conversation.updatedAtMs,
      }));
  }

  /** The full stored conversation for `id` (its text history), or `null` if unknown. */
  get(id: string): StoredConversation | null {
    return this.conversations.find((conversation) => conversation.id === id) ?? null;
  }

  /**
   * Persists `id`'s current text history: creating the conversation on its first turn or
   * updating it in place afterwards, then evicting the oldest beyond the cap and writing
   * the whole set. An empty history is a no-op, so a brand-new conversation the user has
   * opened but not yet sent to never leaves an empty entry on disk.
   */
  save(id: string, messages: ConversationMessage[]): void {
    if (messages.length === 0) {
      return;
    }

    const nowMs = this.now();
    const messagesCopy = messages.map((message) => ({ ...message }));
    const existing = this.conversations.find((conversation) => conversation.id === id);
    if (existing) {
      existing.messages = messagesCopy;
      existing.updatedAtMs = nowMs;
    } else {
      this.conversations.push({
        id,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        messages: messagesCopy,
      });
    }

    this.conversations = pruneToCap(this.conversations, MAX_CONVERSATIONS);
    this.persist();
  }

  private load(): StoredConversation[] {
    let raw: string;
    try {
      raw = this.readFile(this.filePath);
    } catch {
      // No file yet (first run) or an unreadable one - start with no history.
      return [];
    }
    try {
      return StoreDocumentSchema.parse(JSON.parse(raw)).conversations;
    } catch {
      // Corrupt or hand-mangled file: fall back to empty rather than crashing the app
      // (or seeding the Core from a malformed turn). The next save overwrites it cleanly.
      return [];
    }
  }

  private persist(): void {
    try {
      this.writeFile(
        this.filePath,
        JSON.stringify({ version: STORE_VERSION, conversations: this.conversations }),
      );
    } catch (error) {
      // A lost write (read-only disk, permissions) costs at most this session's history
      // on the next launch - never worth crashing the app the user is mid-conversation with.
      console.error("[lune] could not persist conversation history:", error);
    }
  }
}
