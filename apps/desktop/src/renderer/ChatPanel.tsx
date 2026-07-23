import { useEffect, useRef, useState } from "react";
import { useConversationStore, type ConversationMessageView } from "./conversationStore";

// The Chat Panel (ticket 06): the conversation surface opened from the Pill. It renders
// the Core-owned conversation - the user's turns and Lune's streamed replies - and
// carries a composer for typing the next turn. Typed turns are screen-aware (ticket 05
// is done), so each turn is sent with `includeScreen` on. It shares the Pill's design
// language (dark, rounded, blurred). Voice turns will render here unchanged (ticket 11).

export function ChatPanel() {
  const messages = useConversationStore((state) => state.messages);
  const turnStatus = useConversationStore((state) => state.turnStatus);
  const errorMessage = useConversationStore((state) => state.errorMessage);
  const beginTurn = useConversationStore((state) => state.beginTurn);
  const applyEvent = useConversationStore((state) => state.applyEvent);

  const [draftPrompt, setDraftPrompt] = useState("");
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Subscribe to the Core's streamed events for the life of the panel, feeding each
  // into the store (which ignores events from any superseded turn).
  useEffect(() => window.lune.chat.onChatEvent(applyEvent), [applyEvent]);

  // Keep the newest message in view as turns arrive and replies stream in.
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [messages]);

  function sendTurn() {
    const prompt = draftPrompt.trim();
    if (prompt.length === 0 || turnStatus === "streaming") {
      return;
    }
    const turnId = crypto.randomUUID();
    beginTurn(turnId);
    // Screen-aware by default (ticket 05); text-entered this turn.
    window.lune.chat.start({ turnId, prompt, inputMethod: "text", includeScreen: true });
    setDraftPrompt("");
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden border border-white/10 bg-neutral-900/90 text-neutral-100 backdrop-blur-md">
      <header className="app-drag flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-neutral-200">Lune</span>
        <button
          type="button"
          onClick={() => window.lune.chatPanel.toggle()}
          aria-label="Close chat panel"
          className="app-no-drag flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
        >
          ✕
        </button>
      </header>

      <div ref={scrollContainerRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
        {turnStatus === "error" && (
          <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs leading-snug text-rose-300">
            {errorMessage ?? "Something went wrong. Please try again."}
          </p>
        )}
      </div>

      <div className="border-t border-white/10 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draftPrompt}
            onChange={(event) => setDraftPrompt(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter inserts a newline for a longer message.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendTurn();
              }
            }}
            rows={1}
            placeholder="Ask Lune about your screen..."
            className="app-no-drag max-h-28 min-h-[2.25rem] flex-1 resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs leading-snug text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
          />
          <button
            type="button"
            onClick={sendTurn}
            disabled={turnStatus === "streaming" || draftPrompt.trim().length === 0}
            className="app-no-drag flex h-9 shrink-0 cursor-pointer items-center rounded-xl bg-white/15 px-3.5 text-xs font-medium text-neutral-100 transition hover:bg-white/25 disabled:cursor-default disabled:opacity-40"
          >
            {turnStatus === "streaming" ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The pre-conversation prompt, so an empty panel explains itself rather than looking broken. */
function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-neutral-300">Talk to Lune</p>
      <p className="mt-1 text-xs leading-snug text-neutral-500">
        Ask about what's on your screen, or anything else. Your message and Lune's reply
        appear here.
      </p>
    </div>
  );
}

/** One message bubble: the user's turns align right, Lune's replies left. */
function MessageBubble({ message }: { message: ConversationMessageView }) {
  const isUser = message.role === "user";
  // A reply that has started streaming but has no text yet shows a thinking hint rather
  // than an empty bubble, so progress is always visible (never silence).
  const isAwaitingFirstToken = message.role === "assistant" && message.text.length === 0;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs leading-relaxed ${
          isUser ? "bg-white/15 text-neutral-100" : "bg-white/5 text-neutral-200"
        }`}
      >
        {isAwaitingFirstToken ? <span className="text-neutral-500">Thinking...</span> : message.text}
      </div>
    </div>
  );
}
