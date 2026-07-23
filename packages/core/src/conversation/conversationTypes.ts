/**
 * The Core's conversation model (ticket 06). Conversation state lives in the Core -
 * the Shell's Chat Panel renders it - so these are the Core's native shapes, not any
 * one surface's view model.
 *
 * A conversation is one unified history of turns. Each user turn records the input
 * method it arrived by (typed, or - from ticket 11 - spoken), so voice and text land
 * in the same history and the voice loop slots in without a schema change. Assistant
 * replies have no input method; they answer whatever the user's turn was.
 */

/** How the user provided a turn's input. Voice arrives in ticket 11; the field is here now. */
export type ChatInputMethod = "text" | "voice";

/** A user's turn in the conversation: the text (typed or transcribed) and how it arrived. */
export interface UserConversationMessage {
  id: string;
  role: "user";
  inputMethod: ChatInputMethod;
  text: string;
}

/** Lune's reply to a user turn. */
export interface AssistantConversationMessage {
  id: string;
  role: "assistant";
  text: string;
}

export type ConversationMessage = UserConversationMessage | AssistantConversationMessage;

/**
 * One streamed event of a conversation turn, in the Core's native shape. A turn emits
 * exactly one `user-message` (the Core has appended the user's turn), then one
 * `assistant-started`, then zero or more `assistant-delta`s carrying the reply
 * token-by-token, closed by one `assistant-completed` on success. A failure is thrown
 * (not yielded), matching the Reasoning pipeline - so the Shell's `for await` either
 * drains a complete turn or catches the error to surface it.
 */
export type CoreConversationEvent =
  | { type: "user-message"; message: UserConversationMessage }
  | { type: "assistant-started"; messageId: string }
  | { type: "assistant-delta"; messageId: string; text: string }
  | { type: "assistant-completed"; messageId: string };
