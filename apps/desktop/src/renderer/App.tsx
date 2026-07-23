import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { LUNE_IPC_VERSION } from "@lune/shared";
import { useChatStore } from "./store";

// The walking-skeleton surface: a bare panel with a text box that streams a Gemini
// answer token-by-token (ticket 02). Typing a question flows renderer -> preload ->
// main -> Core -> Gemini, and the streamed reply flows back the same way, proving
// the whole architecture end to end. The real Pill, Chat Panel, and Overlay are
// built in later tickets.
export function App() {
  const status = useChatStore((state) => state.status);
  const answerText = useChatStore((state) => state.answerText);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const beginTurn = useChatStore((state) => state.beginTurn);
  const applyChatEvent = useChatStore((state) => state.applyChatEvent);

  const [draftQuestion, setDraftQuestion] = useState("");

  // Subscribe once to the Core's streamed chat events for this window's lifetime.
  // The store filters by the active turn id, so a single long-lived subscription
  // correctly serves every turn.
  useEffect(() => window.lune.chat.onChatEvent(applyChatEvent), [applyChatEvent]);

  function submitQuestion() {
    const trimmedQuestion = draftQuestion.trim();
    if (trimmedQuestion.length === 0 || status === "streaming") {
      return;
    }
    const turnId = crypto.randomUUID();
    beginTurn(turnId);
    window.lune.chat.start({ turnId, prompt: trimmedQuestion });
    setDraftQuestion("");
  }

  return (
    <div className="flex h-full flex-col gap-4 bg-neutral-950 p-6 text-neutral-100">
      <div className="flex items-baseline justify-between">
        <motion.h1
          className="text-2xl font-semibold tracking-tight"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          Lune
        </motion.h1>
        <span className="text-xs text-neutral-500">IPC contract v{LUNE_IPC_VERSION}</span>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          submitQuestion();
        }}
      >
        <input
          type="text"
          value={draftQuestion}
          onChange={(changeEvent) => setDraftQuestion(changeEvent.target.value)}
          placeholder="Ask Lune anything..."
          className="min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={status === "streaming" || draftQuestion.trim().length === 0}
          className="cursor-pointer rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-default disabled:opacity-50"
        >
          {status === "streaming" ? "..." : "Ask"}
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-neutral-900 px-4 py-3 text-sm leading-relaxed">
        {status === "idle" && (
          <p className="text-neutral-500">The streamed answer will appear here.</p>
        )}
        {status === "error" ? (
          <p className="text-rose-400">{errorMessage}</p>
        ) : (
          <p className="whitespace-pre-wrap text-neutral-100">
            {answerText}
            {status === "streaming" && (
              <motion.span
                className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-indigo-400"
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
              />
            )}
          </p>
        )}
      </div>
    </div>
  );
}
