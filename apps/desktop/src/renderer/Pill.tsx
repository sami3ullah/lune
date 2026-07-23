import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { StateIndicator, labelForState } from "./StateIndicator";
import { PILL_INDICATOR_STATES, usePillStore, type PillIndicatorState } from "./pillStore";
import { ScreenAccessSection } from "./ScreenAccessSection";
import { MicAccessSection } from "./MicAccessSection";
import { useSpeechPlayback } from "./useSpeechPlayback";
import { useVoiceRecording } from "./useVoiceRecording";

// The Pill: Lune's home surface (ticket 04). A thin always-on-top bar that expands
// into its menu on hover. The window is frameless and transparent and sized to this
// content by the main process, so the layout here is what the user sees floating
// over their desktop - nothing more. The Chat Panel (ticket 06) and Settings (ticket
// 13) menu targets open their windows; voice/reasoning/speech will later drive the
// state indicator, and a dev control drives it until then.

const IS_DEV = import.meta.env.DEV;

export function Pill() {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const indicatorState = usePillStore((state) => state.indicatorState);
  const setIndicatorState = usePillStore((state) => state.setIndicatorState);

  // The Pill owns Lune's audio output: it plays the Kokoro speech clips the main
  // process streams over IPC and drives the "speaking" state while they play (ticket 09).
  useSpeechPlayback();

  // The Pill also owns the mic: it records push-to-talk audio when the main process
  // (driven by the global hotkey) tells it to, streaming the live level for the Overlay
  // waveform and the finished clip back for transcription (ticket 11).
  useVoiceRecording();

  // The voice loop drives the Pill's listening/thinking/idle state over IPC; Kokoro
  // playback drives speaking/idle separately (useSpeechPlayback). Together they light
  // the at-a-glance indicator through a full voice turn (user story 15).
  useEffect(
    () => window.lune.voice.onPillActivity((activity) => setIndicatorState(activity.state)),
    [setIndicatorState],
  );

  // The main process sizes the frameless window to whatever we render, so it must
  // learn the current content size: on first paint, on every hover expand, and -
  // via the menu's exit-complete - once it has collapsed back. Measuring the wrapper
  // (which the transform-based menu animation never resizes) keeps the window exactly
  // as large as the visible pill, leaving no invisible region to eat stray clicks.
  const reportContentSize = useCallback(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    window.lune.pill.reportContentSize({
      width: Math.max(1, Math.ceil(width)),
      height: Math.max(1, Math.ceil(height)),
    });
  }, []);

  useLayoutEffect(() => {
    reportContentSize();
  }, [menuOpen, reportContentSize]);

  return (
    <div
      ref={wrapperRef}
      className="app-no-drag inline-flex flex-col items-center"
      onMouseEnter={() => setMenuOpen(true)}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <div className="app-drag flex items-center gap-2 rounded-full border border-white/10 bg-neutral-900/85 px-3 py-1.5 text-neutral-100 shadow-lg shadow-black/40 backdrop-blur-md">
        <StateIndicator state={indicatorState} />
        <span className="text-xs font-medium tracking-wide">Lune</span>
      </div>

      <AnimatePresence onExitComplete={reportContentSize}>
        {menuOpen && (
          <motion.div
            className="mt-1.5 w-52 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/90 p-1.5 text-neutral-100 shadow-xl shadow-black/50 backdrop-blur-md"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <MenuButton label="Chat Panel" onClick={() => window.lune.chatPanel.toggle()} />
            <MenuButton label="Settings" onClick={() => window.lune.settings.toggle()} />
            <MenuButton label="Quit Lune" onClick={() => window.lune.pill.quit()} />
            <ScreenAccessSection />
            <MicAccessSection />
            {IS_DEV && <DevStateSwitcher current={indicatorState} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A live menu row - pointer cursor, hover highlight, real action. */
function MenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="app-no-drag flex w-full cursor-pointer items-center rounded-xl px-3 py-2 text-left text-sm text-neutral-100 transition hover:bg-white/10"
    >
      {label}
    </button>
  );
}

/**
 * Dev-only control to cycle the state indicator through its five states until the
 * real voice/reasoning/speech states arrive to drive it (ticket 04 acceptance).
 * Compiled out of production by the `import.meta.env.DEV` guard at the call site.
 */
function DevStateSwitcher({ current }: { current: PillIndicatorState }) {
  const setIndicatorState = usePillStore((state) => state.setIndicatorState);
  return (
    <div className="mt-1.5 border-t border-white/10 pt-1.5">
      <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">Dev · state</p>
      <div className="flex flex-col">
        {PILL_INDICATOR_STATES.map((state) => (
          <button
            key={state}
            type="button"
            onClick={() => setIndicatorState(state)}
            className={`app-no-drag flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1 text-left text-xs transition hover:bg-white/10 ${
              state === current ? "text-neutral-100" : "text-neutral-500"
            }`}
          >
            <StateIndicator state={state} />
            {labelForState(state)}
          </button>
        ))}
      </div>
    </div>
  );
}
