import { beforeEach, describe, expect, it } from "vitest";
import { useConversationStore } from "../src/renderer/conversationStore";
import type { ConversationStreamEvent } from "@lune/shared";

// The store folds the Core's streamed events into the message list the Chat Panel
// renders. These tests exercise that projection directly (pure state, no DOM), the
// one piece of Chat Panel logic the M1 plan unit-tests; the surface itself is manual.

const TURN_ID = "turn-1";

/** Resets the singleton store between tests. */
beforeEach(() => {
  useConversationStore.setState({
    messages: [],
    activeTurnId: null,
    committedMessageCount: 0,
    turnStatus: "idle",
    errorMessage: null,
    conversations: [],
    activeConversationId: null,
  });
});

/** Applies a sequence of events through the store's reducer. */
function applyAll(events: ConversationStreamEvent[]): void {
  for (const event of events) {
    useConversationStore.getState().applyEvent(event);
  }
}

describe("conversationStore projection", () => {
  it("appends the user turn then streams the reply into one growing assistant message", () => {
    useConversationStore.getState().beginTurn(TURN_ID);
    applyAll([
      { type: "started", turnId: TURN_ID, ipcVersion: 4 },
      { type: "user-message", turnId: TURN_ID, messageId: "u1", text: "hi", inputMethod: "text" },
      { type: "assistant-started", turnId: TURN_ID, messageId: "a1" },
      { type: "assistant-delta", turnId: TURN_ID, messageId: "a1", text: "Hel" },
      { type: "assistant-delta", turnId: TURN_ID, messageId: "a1", text: "lo" },
      { type: "assistant-completed", turnId: TURN_ID, messageId: "a1" },
    ]);

    const state = useConversationStore.getState();
    expect(state.messages).toEqual([
      { id: "u1", role: "user", inputMethod: "text", text: "hi" },
      { id: "a1", role: "assistant", text: "Hello" },
    ]);
    expect(state.turnStatus).toBe("idle");
  });

  it("preserves prior turns across a new turn (history is not cleared)", () => {
    useConversationStore.getState().beginTurn(TURN_ID);
    applyAll([
      { type: "user-message", turnId: TURN_ID, messageId: "u1", text: "first", inputMethod: "text" },
      { type: "assistant-started", turnId: TURN_ID, messageId: "a1" },
      { type: "assistant-delta", turnId: TURN_ID, messageId: "a1", text: "one" },
      { type: "assistant-completed", turnId: TURN_ID, messageId: "a1" },
    ]);

    const secondTurnId = "turn-2";
    useConversationStore.getState().beginTurn(secondTurnId);
    applyAll([
      { type: "user-message", turnId: secondTurnId, messageId: "u2", text: "second", inputMethod: "text" },
    ]);

    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });

  it("carries the input method through so a voice turn renders as one", () => {
    useConversationStore.getState().beginTurn(TURN_ID);
    applyAll([
      { type: "user-message", turnId: TURN_ID, messageId: "u1", text: "spoken", inputMethod: "voice" },
    ]);
    expect(useConversationStore.getState().messages[0]).toMatchObject({ inputMethod: "voice" });
  });

  it("surfaces an error and rolls the failed turn back to mirror the Core's history", () => {
    useConversationStore.getState().beginTurn(TURN_ID);
    applyAll([
      { type: "user-message", turnId: TURN_ID, messageId: "u1", text: "boom", inputMethod: "text" },
      { type: "assistant-started", turnId: TURN_ID, messageId: "a1" },
      { type: "error", turnId: TURN_ID, message: "Vendor rejected the request" },
    ]);

    const state = useConversationStore.getState();
    expect(state.turnStatus).toBe("error");
    expect(state.errorMessage).toBe("Vendor rejected the request");
    // The Core committed nothing for this turn, so the panel shows nothing for it -
    // no phantom user bubble, no stuck "Thinking..." assistant bubble.
    expect(state.messages).toEqual([]);
  });

  it("keeps prior committed turns when a later turn fails", () => {
    useConversationStore.getState().beginTurn("turn-ok");
    applyAll([
      { type: "user-message", turnId: "turn-ok", messageId: "u1", text: "first", inputMethod: "text" },
      { type: "assistant-started", turnId: "turn-ok", messageId: "a1" },
      { type: "assistant-delta", turnId: "turn-ok", messageId: "a1", text: "reply" },
      { type: "assistant-completed", turnId: "turn-ok", messageId: "a1" },
    ]);

    useConversationStore.getState().beginTurn("turn-fail");
    applyAll([
      { type: "user-message", turnId: "turn-fail", messageId: "u2", text: "second", inputMethod: "text" },
      { type: "assistant-started", turnId: "turn-fail", messageId: "a2" },
      { type: "error", turnId: "turn-fail", message: "boom" },
    ]);

    // Only the failed turn is rolled back; the completed turn survives.
    expect(useConversationStore.getState().messages).toEqual([
      { id: "u1", role: "user", inputMethod: "text", text: "first" },
      { id: "a1", role: "assistant", text: "reply" },
    ]);
  });

  it("ignores events from a superseded turn", () => {
    useConversationStore.getState().beginTurn("turn-current");
    // A late delta from an abandoned turn must not bleed into the current one.
    applyAll([
      { type: "assistant-delta", turnId: "turn-old", messageId: "a-old", text: "stale" },
    ]);
    expect(useConversationStore.getState().messages).toEqual([]);
  });
});

describe("conversationStore recent-conversations (ticket 12)", () => {
  it("mirrors the Shell's list + active id for the dropdown", () => {
    useConversationStore.getState().setConversationList({
      conversations: [
        { id: "c2", title: "second", updatedAtMs: 20 },
        { id: "c1", title: "first", updatedAtMs: 10 },
      ],
      activeId: "c2",
    });

    const state = useConversationStore.getState();
    expect(state.conversations.map((conversation) => conversation.id)).toEqual(["c2", "c1"]);
    expect(state.activeConversationId).toBe("c2");
  });

  it("resumes a conversation by rendering its full text history and making it active", () => {
    // Start from a different conversation's leftover state...
    useConversationStore.setState({
      messages: [{ id: "old", role: "user", text: "stale" }],
      turnStatus: "error",
      errorMessage: "boom",
    });

    useConversationStore.getState().resumeConversation({
      activeId: "resumed-1",
      messages: [
        { id: "u1", role: "user", inputMethod: "text", text: "what is this?" },
        { id: "a1", role: "assistant", text: "a config file" },
      ],
    });

    const state = useConversationStore.getState();
    expect(state.activeConversationId).toBe("resumed-1");
    expect(state.messages).toEqual([
      { id: "u1", role: "user", inputMethod: "text", text: "what is this?" },
      { id: "a1", role: "assistant", text: "a config file" },
    ]);
    // Turn state is reset so the panel is clean and ready for the next turn.
    expect(state.turnStatus).toBe("idle");
    expect(state.errorMessage).toBeNull();
    // The whole resumed history counts as committed, so a later failed turn rolls back to it.
    expect(state.committedMessageCount).toBe(2);
  });

  it("carries the input method through a resumed voice turn", () => {
    useConversationStore.getState().resumeConversation({
      activeId: "resumed-1",
      messages: [{ id: "u1", role: "user", inputMethod: "voice", text: "spoken" }],
    });
    expect(useConversationStore.getState().messages[0]).toMatchObject({ inputMethod: "voice" });
  });

  it("starts a new conversation by clearing the rendered history", () => {
    useConversationStore.setState({
      messages: [{ id: "old", role: "user", text: "previous" }],
      committedMessageCount: 1,
    });

    useConversationStore.getState().startNewConversation("fresh-1");

    const state = useConversationStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.activeConversationId).toBe("fresh-1");
    expect(state.committedMessageCount).toBe(0);
    expect(state.turnStatus).toBe("idle");
  });
});
