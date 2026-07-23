import { create } from "zustand";
import type { ChatInputMethod, ConversationStreamEvent } from "@lune/shared";

// The renderer's projection of the Core-owned conversation (ticket 06). Conversation
// state lives in the Core; this store simply folds the streamed events into the shape
// the Chat Panel renders. Because both the user's turn and Lune's reply arrive as
// events from the Core, voice turns (ticket 11) will render through this exact path -
// there is no separate "my typed message" bookkeeping to diverge.

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
  /** Begins a fresh turn, taking ownership of `turnId` (history is preserved). */
  beginTurn: (turnId: string) => void;
  /** Applies one streamed conversation event, ignoring events from a superseded turn. */
  applyEvent: (event: ConversationStreamEvent) => void;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  messages: [],
  activeTurnId: null,
  committedMessageCount: 0,
  turnStatus: "idle",
  errorMessage: null,
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
}));
