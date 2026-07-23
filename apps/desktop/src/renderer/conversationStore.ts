import { create } from "zustand";
import type { ChatInputMethod, ConversationStreamEvent } from "@lune/shared";
import type { ConversationSummaryValue, ResumedConversationValue } from "../ipc/conversations";

// The renderer's projection of the Core-owned conversation (ticket 06). Conversation
// state lives in the Core; this store simply folds the streamed events into the shape
// the Chat Panel renders. Because both the user's turn and Lune's reply arrive as
// events from the Core, voice turns (ticket 11) will render through this exact path -
// there is no separate "my typed message" bookkeeping to diverge.
//
// Ticket 12 adds the recent-conversations dropdown: the store also holds the last-10
// list and which conversation is active, plus the transitions for resuming a stored
// conversation and starting a fresh one. The list itself lives in the Shell's durable
// store; this mirrors what that store reports so the dropdown renders without owning
// persistence.

/** One rendered message. `inputMethod` is present on user turns only. */
export interface ConversationMessageView {
  id: string;
  role: "user" | "assistant";
  inputMethod?: ChatInputMethod;
  text: string;
}

/** Where the in-flight turn is in its lifecycle (drives the composer's enabled state). */
export type ConversationTurnStatus = "idle" | "streaming" | "error";

interface ConversationState {
  /** The full conversation, oldest first. */
  messages: ConversationMessageView[];
  /** The id of the turn currently owning the stream; events from any other turn are ignored. */
  activeTurnId: string | null;
  /**
   * How many messages were committed before the in-flight turn began. The Core commits
   * a turn's user + assistant messages only when the reply completes and rolls the
   * whole turn back on failure; the panel mirrors that by truncating to this count on
   * an error, so the rendered conversation never drifts from the Core's history.
   */
  committedMessageCount: number;
  turnStatus: ConversationTurnStatus;
  errorMessage: string | null;
  /** The recent conversations for the dropdown, newest first (as the Shell reports them). */
  conversations: ConversationSummaryView[];
  /** Which conversation is active, or `null` for a fresh one not yet persisted. */
  activeConversationId: string | null;
  /** Begins a fresh turn, taking ownership of `turnId` (history is preserved). */
  beginTurn: (turnId: string) => void;
  /** Applies one streamed conversation event, ignoring events from a superseded turn. */
  applyEvent: (event: ConversationStreamEvent) => void;
  /** Mirrors the Shell's recent-conversations list + active id into the dropdown's state. */
  setConversationList: (snapshot: {
    conversations: ConversationSummaryView[];
    activeId: string | null;
  }) => void;
  /** Switches to a resumed conversation: renders its full text history and makes it active. */
  resumeConversation: (resumed: ResumedConversationValue) => void;
  /** Switches to a fresh, empty conversation, clearing the rendered history. */
  startNewConversation: (activeId: string) => void;
}

/** One conversation as the dropdown shows it. */
export type ConversationSummaryView = ConversationSummaryValue;

/** Projects the resumed conversation's messages into the panel's render shape. */
function toMessageViews(messages: ResumedConversationValue["messages"]): ConversationMessageView[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    inputMethod: message.role === "user" ? message.inputMethod : undefined,
    text: message.text,
  }));
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  messages: [],
  activeTurnId: null,
  committedMessageCount: 0,
  turnStatus: "idle",
  errorMessage: null,
  conversations: [],
  activeConversationId: null,
  beginTurn: (turnId) =>
    set((state) => ({
      activeTurnId: turnId,
      turnStatus: "streaming",
      errorMessage: null,
      committedMessageCount: state.messages.length,
    })),
  applyEvent: (event) => {
    // Drop events from a turn the panel no longer owns.
    if (event.turnId !== get().activeTurnId) {
      return;
    }
    switch (event.type) {
      case "started":
        // The turn opened; the stamped ipcVersion is a contract literal, so a mismatch
        // is already caught at validation. Nothing to render yet.
        return;
      case "user-message":
        set((state) => ({
          messages: [
            ...state.messages,
            { id: event.messageId, role: "user", inputMethod: event.inputMethod, text: event.text },
          ],
        }));
        return;
      case "assistant-started":
        set((state) => ({
          messages: [...state.messages, { id: event.messageId, role: "assistant", text: "" }],
        }));
        return;
      case "assistant-delta":
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === event.messageId
              ? { ...message, text: message.text + event.text }
              : message,
          ),
        }));
        return;
      case "assistant-completed":
        set({ turnStatus: "idle" });
        return;
      case "error":
        // Mirror the Core's rollback: drop this turn's (uncommitted) user + assistant
        // messages so the panel keeps showing exactly the Core's committed history,
        // and surface the failure as a readable banner rather than a stuck bubble.
        set((state) => ({
          messages: state.messages.slice(0, state.committedMessageCount),
          turnStatus: "error",
          errorMessage: event.message,
        }));
        return;
    }
  },
  setConversationList: (snapshot) =>
    set({ conversations: snapshot.conversations, activeConversationId: snapshot.activeId }),
  resumeConversation: (resumed) =>
    // Replace the rendered history with the resumed conversation's, and reset turn state
    // so the panel is ready for its next turn (which answers with fresh screen context).
    set({
      messages: toMessageViews(resumed.messages),
      activeConversationId: resumed.activeId,
      activeTurnId: null,
      committedMessageCount: resumed.messages.length,
      turnStatus: "idle",
      errorMessage: null,
    }),
  startNewConversation: (activeId) =>
    set({
      messages: [],
      activeConversationId: activeId,
      activeTurnId: null,
      committedMessageCount: 0,
      turnStatus: "idle",
      errorMessage: null,
    }),
}));
