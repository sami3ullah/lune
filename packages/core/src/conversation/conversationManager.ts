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
 * The manager holds one *active* conversation. Ticket 12 adds `loadConversation`: the
 * Shell's durable last-10 store seeds the manager with a resumed conversation's prior
 * messages, or an empty history to start a new one. Persistence of the set of
 * conversations (text only, oldest pruned beyond 10) is the Shell's concern - the Core
 * stays transport- and filesystem-agnostic; only the active conversation's turn logic
 * lives here.
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
  /**
   * Cancels this turn's in-flight Reasoning stream when signalled (Barge-in, ticket
   * 11): the push-to-talk hotkey pressed mid-answer aborts the turn. An aborted turn
   * throws out of {@link ConversationManager.submitUserTurn} before the commit, so it
   * leaves no trace in history - exactly like any other failed turn.
   */
  signal?: AbortSignal;
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
  /**
   * Replaces the active conversation's committed history (ticket 12). Called with a
   * resumed conversation's prior messages to continue it, or an empty array to start
   * a fresh one. The messages are defensively copied, so the caller's array (the
   * Shell's persisted snapshot) is never aliased into committed state.
   */
  loadConversation(messages: ConversationMessage[]): void;
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

    try {
      for await (const streamEvent of reasoningCapability.streamChat(request, { signal: input.signal })) {
        if (streamEvent.type === "text-delta") {
          assistantMessage.text += streamEvent.text;
          yield { type: "assistant-delta", messageId: assistantMessage.id, text: streamEvent.text };
        }
        // The stream's terminal `done` simply ends the loop.
      }
    } catch (streamError) {
      // A deliberate interruption (Barge-in) is not a failure: the user pressed the
      // hotkey to add to or redirect the conversation, so keep the interrupted turn -
      // their utterance plus whatever the assistant managed to say - in committed history.
      // The next turn is built from that history, so the follow-up merges with, rather
      // than discards, what was just said. A genuine stream failure (signal not aborted)
      // still rolls back, leaving history untouched so it never ends on a dangling turn.
      if (input.signal?.aborted) {
        committedMessages.push(userMessage, assistantMessage);
      }
      throw streamError;
    }

    committedMessages.push(userMessage, assistantMessage);
    yield { type: "assistant-completed", messageId: assistantMessage.id };
  }

  function loadConversation(messages: ConversationMessage[]): void {
    // Replace in place (rather than rebind) so the closure the in-flight turn holds
    // keeps referencing the live history; defensively copy each message so the Shell's
    // persisted snapshot is never aliased into committed state.
    committedMessages.length = 0;
    committedMessages.push(...messages.map((message) => ({ ...message })));
  }

  return {
    submitUserTurn,
    getMessages: () => committedMessages.map((message) => ({ ...message })),
    loadConversation,
  };
}
