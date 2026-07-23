/**
 * Turns a conversation's messages into one Reasoning request that honors multi-turn
 * context (ticket 06). The prior turns become plain-text history and the current
 * user turn (always the last message) carries this turn's screen context as image +
 * label blocks - so the model reads the whole conversation but only ever sees the
 * screenshots of the turn being answered (a resumed conversation starts with fresh
 * screen context; screenshots are never part of stored history).
 *
 * Building history as alternating plain-text user/assistant messages, with the
 * current user turn last, matches what every Vendor expects (the Core commits only
 * completed user/assistant pairs, so the history handed here is always well-formed).
 */
import { screenAwareChatRequest } from "../reasoning/chatTypes.js";
import type { CoreChatRequest, ScreenCaptureInput } from "../reasoning/chatTypes.js";
import type { ConversationMessage } from "./conversationTypes.js";

export function buildConversationRequest(
  messages: ConversationMessage[],
  currentTurnScreens: ScreenCaptureInput[],
): CoreChatRequest {
  if (messages.length === 0) {
    return { messages: [] };
  }

  // Everything before the current turn is history: plain text, no screenshots.
  const priorMessages = messages.slice(0, -1).map((message) => ({
    role: message.role,
    content: message.text,
  }));

  // The current user turn carries this turn's screen context. Reusing the ticket-05
  // builder keeps the "image + dimensioned label, prompt last" shape in one place; it
  // degrades to plain text when nothing was captured.
  const currentTurn = messages[messages.length - 1]!;
  const currentTurnMessage = screenAwareChatRequest(currentTurn.text, currentTurnScreens).messages[0]!;

  return { messages: [...priorMessages, currentTurnMessage] };
}
