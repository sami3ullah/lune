import { create } from "zustand";
import type { ChatStreamEvent } from "@lune/shared";

/** Where the current (or most recent) chat turn is in its lifecycle. */
export type ChatTurnStatus = "idle" | "streaming" | "done" | "error";

interface ChatState {
  /** The id of the turn currently owning the panel; events from any other turn are ignored. */
  activeTurnId: string | null;
  status: ChatTurnStatus;
  /** The answer accumulated so far, appended delta-by-delta as it streams in. */
  answerText: string;
  errorMessage: string | null;
  /** Begins a fresh turn, clearing the previous answer and taking ownership of `turnId`. */
  beginTurn: (turnId: string) => void;
  /** Applies one streamed event, ignoring it if it belongs to a superseded turn. */
  applyChatEvent: (event: ChatStreamEvent) => void;
}

// The renderer's chat state. The walking skeleton drives a single turn at a time,
// but events are still filtered by `activeTurnId` so a slow event from an abandoned
// turn can never bleed into a newer answer. Real conversation history (the last-10
// dropdown, voice+text turns) arrives with the Chat Panel ticket.
export const useChatStore = create<ChatState>((set, get) => ({
  activeTurnId: null,
  status: "idle",
  answerText: "",
  errorMessage: null,
  beginTurn: (turnId) =>
    set({ activeTurnId: turnId, status: "streaming", answerText: "", errorMessage: null }),
  applyChatEvent: (event) => {
    // Drop events from a turn the panel no longer owns.
    if (event.turnId !== get().activeTurnId) {
      return;
    }
    switch (event.type) {
      case "started":
        // The turn opened; nothing to render yet. (The stamped ipcVersion is a
        // literal in the shared contract, so a mismatch is caught at validation.)
        return;
      case "delta":
        set((state) => ({ answerText: state.answerText + event.text }));
        return;
      case "done":
        set({ status: "done" });
        return;
      case "error":
        set({ status: "error", errorMessage: event.message });
        return;
    }
  },
}));
