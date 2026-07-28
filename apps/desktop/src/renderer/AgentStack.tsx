import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAgentStackStore } from "./agentStackStore";
import { deriveCardView, type AgentCardTone, type AgentCardView } from "./agentCards";
import { playCompletionChime } from "./completionChime";

// The Agent Stack surface (M5-03): the background-work window. Each running Task Agent is a
// card fixed top-right under the menu bar, stacking downward - a "Running" badge and a live
// progress bar under the agent's own friendly narration while it works, then a settled "Done"
// state with an Open button for whatever it produced, × to dismiss. The user keeps working
// freely; the window (frameless, transparent, content-sized by the main process) only ever
// covers the cards, so nothing behind it is blocked.
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
  // A live `succeeded` also plays the soft completion chime - only for events that actually
  // stream in, never the already-finished sessions the seed backfills on mount.
  useEffect(() => {
    const unsubscribeEvents = window.lune.taskAgent.onTaskAgentEvent((event) => {
      if (event.type === "succeeded") {
        playCompletionChime();
      }
      applyEvent(event);
    });
    // Revealed from the Pill: re-seed from the runtime's current snapshots so sessions the user
    // dismissed from the stack (but that are still tracked) reappear rather than staying hidden.
    const unsubscribeReseed = window.lune.agentStack.onReseed(() => {
      void window.lune.taskAgent.list().then(seed);
    });
    void window.lune.taskAgent.list().then(seed);
    return () => {
      unsubscribeEvents();
      unsubscribeReseed();
    };
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
  // The detail can be expanded in place when it's a settled summary or a long line the
  // clamp would otherwise cut off.
  const canExpandDetail = view.isTerminal && (openable?.kind === "summary" || view.detail.length > 90);

  const handleOpenResult = useCallback(() => {
    if (openable !== null && openable.kind !== "summary") {
      window.lune.agentStack.openResult(openable);
      // Opening the result means the user is done with this card - clear it (and, if it was the
      // last, the stack panel closes with it), so the surface gets out of their way.
      onDismiss();
    }
  }, [openable, onDismiss]);

  const handleRetry = useCallback(() => {
    // Re-run the same goal in the background. The new run opens its own card via the event
    // stream, so the spent failed card is cleared to avoid two cards for one intent.
    if (view.goal.trim().length > 0) {
      void window.lune.taskAgent.start({ goal: view.goal });
    }
    onDismiss();
  }, [view.goal, onDismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 16, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 16, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 520, damping: 30, mass: 0.8 }}
      className="rounded-2xl border border-white/10 bg-neutral-950/95 px-4 py-3 text-neutral-100 shadow-lg shadow-black/30"
    >
      {/* Header: the goal, the live status badge, and dismiss. */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold" title={view.goal}>
          {view.goal || "Working…"}
        </div>
        <StatusBadge tone={tone} label={view.badge} pulsing={!view.isTerminal} />
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="rounded-lg px-1.5 py-0.5 text-neutral-500 transition hover:bg-white/10 hover:text-neutral-200"
        >
          ×
        </button>
      </div>

      {/* The friendly message, led by a small chat glyph in the card's tone. */}
      <div className="mt-2 flex items-start gap-2">
        <ChatGlyph color={tone} />
        <button
          type="button"
          onClick={canExpandDetail ? () => setExpanded((value) => !value) : undefined}
          className={`block flex-1 text-left text-xs leading-relaxed text-neutral-300 ${
            expanded ? "" : "line-clamp-3"
          } ${canExpandDetail ? "cursor-pointer hover:text-neutral-100" : "cursor-default"}`}
        >
          {view.detail}
        </button>
      </div>

      {/* Footer: a live progress bar while working, the open affordance once done. */}
      {!view.isTerminal ? (
        <div className="mt-3">
          <ProgressBar tone={tone} />
          {view.activityHint !== null && (
            <div className="mt-1.5 truncate text-[11px] text-neutral-500" title={view.activityHint}>
              {view.activityHint}
            </div>
          )}
        </div>
      ) : view.retryable ? (
        // A failed run: offer a one-tap re-run of the same goal (M6-03), so a mid-way failure
        // isn't a dead end the user has to re-ask by voice.
        <div className="mt-3 flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-lg px-3 py-1 text-xs font-semibold text-neutral-950 transition hover:brightness-110"
            style={{ backgroundColor: tone }}
          >
            Try again
          </button>
          <span className="truncate text-[11px] text-neutral-500">we&apos;ll run it again in the background</span>
        </div>
      ) : (
        openable !== null &&
        openable.kind !== "summary" && (
          <div className="mt-3 flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleOpenResult}
              className="rounded-lg px-3 py-1 text-xs font-semibold text-neutral-950 transition hover:brightness-110"
              style={{ backgroundColor: tone }}
            >
              {openable.kind === "file" ? "Open it" : "Open link"}
            </button>
            {view.invitation !== null && (
              <span className="truncate text-[11px] text-neutral-500">{view.invitation}</span>
            )}
          </div>
        )
      )}
    </motion.div>
  );
}

/** The status pill in the card header, with a soft pulse while the agent is still working. */
function StatusBadge({ tone, label, pulsing }: { tone: string; label: string; pulsing: boolean }) {
  return (
    <motion.span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ backgroundColor: `${tone}26`, color: tone }}
      animate={pulsing ? { opacity: [1, 0.55, 1] } : { opacity: 1 }}
      transition={pulsing ? { duration: 1.8, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
    >
      {label}
    </motion.span>
  );
}

/** A small speech-bubble glyph that fronts the friendly message, tinted to the card's tone. */
function ChatGlyph({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="mt-0.5 h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke={color}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2.5V11.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

/** An indeterminate progress bar: a soft segment sweeping across the track in the card's tone. */
function ProgressBar({ tone }: { tone: string }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <motion.div
        className="absolute inset-y-0 w-1/2 rounded-full"
        style={{ background: `linear-gradient(90deg, transparent, ${tone}, transparent)` }}
        animate={{ x: ["-70%", "240%"] }}
        transition={{ duration: 1.7, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
