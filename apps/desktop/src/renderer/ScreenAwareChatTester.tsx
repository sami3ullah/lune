import { useEffect, useState } from "react";
import { useChatStore } from "./store";

// A minimal typed-question surface used to exercise the screen-aware answer path
// (ticket 05 acceptance: a typed question + capture returns an answer that reflects
// what's on screen). It is intentionally bare and dev-only - the real Chat Panel,
// with history and the last-10 dropdown, is ticket 06. This just mints a turn asking
// the Shell to capture the screen, then renders the streamed answer as it arrives.

export function ScreenAwareChatTester() {
  const [draftPrompt, setDraftPrompt] = useState("");
  const status = useChatStore((state) => state.status);
  const answerText = useChatStore((state) => state.answerText);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const beginTurn = useChatStore((state) => state.beginTurn);
  const applyChatEvent = useChatStore((state) => state.applyChatEvent);

  // Subscribe to the streamed events for the life of this surface, feeding each into
  // the chat store (which ignores events from any superseded turn).
  useEffect(() => window.lune.chat.onChatEvent(applyChatEvent), [applyChatEvent]);

  function sendScreenAwareTurn() {
    const prompt = draftPrompt.trim();
    if (prompt.length === 0) {
      return;
    }
    const turnId = crypto.randomUUID();
    beginTurn(turnId);
    window.lune.chat.start({ turnId, prompt, includeScreen: true });
  }

  return (
    <div className="mt-1.5 border-t border-white/10 pt-1.5">
      <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">
        Dev · screen-aware chat
      </p>
      <div className="flex flex-col gap-1.5 px-3 pb-1">
        <input
          type="text"
          value={draftPrompt}
          onChange={(event) => setDraftPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              sendScreenAwareTurn();
            }
          }}
          placeholder="what's on my screen?"
          className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
        />
        <button
          type="button"
          onClick={sendScreenAwareTurn}
          disabled={status === "streaming"}
          className="app-no-drag w-full cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-white/15 disabled:cursor-default disabled:opacity-50"
        >
          {status === "streaming" ? "Answering..." : "Ask with screen"}
        </button>

        {(answerText.length > 0 || status !== "idle") && (
          <div className="max-h-40 overflow-y-auto rounded-lg bg-black/30 px-2.5 py-1.5 text-[11px] leading-snug text-neutral-300">
            {status === "error" ? (
              <span className="text-rose-400">{errorMessage ?? "Something went wrong."}</span>
            ) : (
              <span>{answerText || "..."}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
