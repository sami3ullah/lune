/**
 * The Core's conversation state (ticket 06): the one in-memory history the Chat Panel
 * renders, and the logic that advances it one turn at a time through the Reasoning
 * Capability. Conversation state lives here, not in the Shell - the Shell forwards the
 * user's turn and streams the Core's events back to render them.
 *
 * The load-bearing invariant is that committed history stays well-formed: a turn's
 * user and assistant messages are committed together, only after the reply completes.
 * A turn that fails (the Vendor rejects it, the stream breaks) commits nothing, so the
 * history never ends on a dangling user message that would break the alternating
 * user/assistant shape every Vendor requires. The failure propagates (thrown, like the
 * pipeline) for the Shell to surface as a readable error.
 *
 * In-memory only for now; durable last-10 persistence is ticket 12.
 */
import { buildConversationRequest } from "./buildConversationRequest.js";
import type { ScreenCaptureInput } from "../reasoning/chatTypes.js";
import type { ReasoningCapability } from "../reasoning/reasoningCapability.js";
import type {
  AssistantConversationMessage,
  ChatInputMethod,
  ConversationMessage,
  CoreConversationEvent,
  UserConversationMessage,
} from "./conversationTypes.js";

/** The injected boundaries the conversation manager is built from. */
export interface ConversationManagerDependencies {
  /** The Reasoning Capability that answers each turn (production or a test stub). */
  reasoningCapability: ReasoningCapability;
  /** Mints a unique id per message (injected so tests get deterministic ids). */
  generateMessageId: () => string;
}

/** One user turn the Shell submits: its text, how it arrived, and this turn's screen context. */
export interface SubmitUserTurnInput {
  text: string;
  inputMethod: ChatInputMethod;
  /** The screenshots captured for this turn (empty for a text-only or unpermitted turn). */
  screenshots: ScreenCaptureInput[];
}

export interface ConversationManager {
  /**
   * Runs one turn: appends the user's message, streams Lune's reply with the full
   * conversation as context, and - on success - commits both to history. Yields the
   * turn's events; throws if the reply could not be produced (nothing is committed).
   */
  submitUserTurn(input: SubmitUserTurnInput): AsyncGenerator<CoreConversationEvent>;
  /** A snapshot copy of the committed conversation history. */
  getMessages(): ConversationMessage[];
}

export function createConversationManager(
  dependencies: ConversationManagerDependencies,
): ConversationManager {
  const { reasoningCapability, generateMessageId } = dependencies;

  // The committed history: only completed user/assistant pairs, so it is always
  // well-formed alternating context for the next turn.
  const committedMessages: ConversationMessage[] = [];

  async function* submitUserTurn(
    input: SubmitUserTurnInput,
  ): AsyncGenerator<CoreConversationEvent> {
    const userMessage: UserConversationMessage = {
      id: generateMessageId(),
      role: "user",
      inputMethod: input.inputMethod,
      text: input.text,
    };
    const assistantMessage: AssistantConversationMessage = {
      id: generateMessageId(),
      role: "assistant",
      text: "",
    };

    // Build the request from committed history plus this user turn *before* committing
    // anything. If the turn fails below, history is untouched.
    const request = buildConversationRequest(
      [...committedMessages, userMessage],
      input.screenshots,
    );

    yield { type: "user-message", message: userMessage };
    yield { type: "assistant-started", messageId: assistantMessage.id };

    for await (const streamEvent of reasoningCapability.streamChat(request)) {
      if (streamEvent.type === "text-delta") {
        assistantMessage.text += streamEvent.text;
        yield { type: "assistant-delta", messageId: assistantMessage.id, text: streamEvent.text };
      }
      // The stream's terminal `done` simply ends the loop; a failure throws out of it,
      // skipping the commit below so the turn leaves no trace in history.
    }

    committedMessages.push(userMessage, assistantMessage);
    yield { type: "assistant-completed", messageId: assistantMessage.id };
  }

  return {
    submitUserTurn,
    getMessages: () => committedMessages.map((message) => ({ ...message })),
  };
}
