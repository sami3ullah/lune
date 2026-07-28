import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAgentStackStore } from "./agentStackStore";
import { deriveCardView, type AgentCardTone, type AgentCardView } from "./agentCards";

// The Agent Stack surface (M5-03): the background-work window. Each running Task Agent is a
// card fixed top-right under the menu bar, stacking downward - live status while running, a
// "done brewing" completion state, click to open the result, × to dismiss. The user keeps
// working freely; the window (frameless, transparent, content-sized by the main process) only
// ever covers the cards, so nothing behind it is blocked.
//
// This surface only renders and wires: it seeds its cards from the runtime's current
// snapshots on mount, folds the live event stream into them (both via the store, over the
// pure reducer), and reports its measured size so the main process pins and sizes the window.

/** The accent color per card tone, from the app's state-dot palette. */
const TONE_COLOR: Record<AgentCardTone, string> = {
  working: "#fbbf24", // amber - in progress
  done: "#34d399", // emerald - finished (Lune's active green)
  error: "#fb7185", // rose - failed
  dismissed: "#818cf8", // indigo - stopped
};

export function AgentStack() {
  const cards = useAgentStackStore((state) => state.cards);
  const seed = useAgentStackStore((state) => state.seed);
  const applyEvent = useAgentStackStore((state) => state.applyEvent);
  const dismiss = useAgentStackStore((state) => state.dismiss);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Subscribe to the live event stream first, then seed from the current snapshots, so an
  // event arriving during startup is never lost (the seed only fills sessions not yet seen).
  useEffect(() => {
    const unsubscribe = window.lune.taskAgent.onTaskAgentEvent(applyEvent);
    void window.lune.taskAgent.list().then(seed);
    return unsubscribe;
  }, [applyEvent, seed]);

  // The main process sizes the frameless window to whatever we render and hides it when the
  // last card is gone, so it must learn our content size and card count on every change -
  // and, via the exit-complete hook, once a dismissed card's animation has finished.
  const reportContentSize = useCallback(() => {
    const element = wrapperRef.current;
    const rect = element?.getBoundingClientRect();
    window.lune.agentStack.reportContentSize({
      width: Math.max(1, Math.ceil(rect?.width ?? 1)),
      height: Math.max(1, Math.ceil(rect?.height ?? 1)),
      cardCount: cards.length,
    });
  }, [cards.length]);

  useLayoutEffect(() => {
    reportContentSize();
  }, [cards, reportContentSize]);

  return (
    <div ref={wrapperRef} className="app-no-drag flex w-[340px] flex-col gap-2 p-1">
      <AnimatePresence onExitComplete={reportContentSize}>
        {cards.map((card) => {
          const view = deriveCardView(card);
          return (
            <AgentCardView
              key={card.sessionId}
              view={view}
              onDismiss={() => {
                // Dismiss clears the card; if it's still running, also cancel the session so no
                // background work keeps going for a card the user has waved away.
                if (!view.isTerminal) {
                  void window.lune.taskAgent.cancel(card.sessionId);
                }
                dismiss(card.sessionId);
              }}
            />
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** One Agent Stack card. */
function AgentCardView({ view, onDismiss }: { view: AgentCardView; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const tone = TONE_COLOR[view.tone];
  const openable = view.openable;
  const clickable = openable !== null || (view.isTerminal && view.detail.length > 60);

  const handleOpen = useCallback(() => {
    if (openable !== null && openable.kind !== "summary") {
      window.lune.agentStack.openResult(openable);
      return;
    }
    // A summary (or a long detail) opens in place: expand the card to read the whole thing.
    setExpanded((value) => !value);
  }, [openable]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 16, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 16, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 520, damping: 30, mass: 0.8 }}
      className="rounded-2xl border border-white/10 bg-neutral-950/95 px-4 py-3 text-neutral-100"
    >
      <div className="flex items-start gap-2.5">
        <StatusDot tone={tone} pulsing={!view.isTerminal} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={view.goal}>
            {view.goal || "Working…"}
          </div>
          <div className="mt-0.5 text-[11px] font-medium tracking-wide" style={{ color: tone }}>
            {view.headline}
          </div>
          <button
            type="button"
            onClick={clickable ? handleOpen : undefined}
            className={`mt-1 block w-full text-left text-xs text-neutral-400 ${
              expanded ? "" : "line-clamp-2"
            } ${clickable ? "cursor-pointer hover:text-neutral-200" : "cursor-default"}`}
          >
            {view.detail}
          </button>
          {openable !== null && openable.kind !== "summary" && (
            <button
              type="button"
              onClick={handleOpen}
              className="mt-2 rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-neutral-100 transition hover:bg-white/20"
            >
              {openable.kind === "file" ? "Open file" : "Open link"}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mr-1 -mt-1 rounded-lg px-1.5 py-0.5 text-neutral-500 transition hover:bg-white/10 hover:text-neutral-200"
        >
          ×
        </button>
      </div>
    </motion.div>
  );
}

/** The tone dot: a small glowing core, pulsing while the agent is still working. */
function StatusDot({ tone, pulsing }: { tone: string; pulsing: boolean }) {
  return (
    <span className="relative mt-1 flex h-2 w-2 shrink-0">
      {pulsing && (
        <motion.span
          className="absolute inline-flex h-full w-full rounded-full"
          style={{ backgroundColor: tone }}
          animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <span
        className="relative inline-flex h-2 w-2 rounded-full"
        style={{ backgroundColor: tone, boxShadow: `0 0 6px ${tone}` }}
      />
    </span>
  );
}
