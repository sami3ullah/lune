import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { StateIndicator, labelForState } from "./StateIndicator";
import { PILL_INDICATOR_STATES, usePillStore, type PillIndicatorState } from "./pillStore";
import { ScreenAccessSection } from "./ScreenAccessSection";
import { MicAccessSection } from "./MicAccessSection";
import { useSpeechPlayback } from "./useSpeechPlayback";
import { useVoiceRecording } from "./useVoiceRecording";
import { useBackgroundTasks } from "./useBackgroundTasks";

// The Pill: Lune's home surface (ticket 04). A thin always-on-top bar, fixed in place,
// that expands into its menu on click. The window is frameless
// and transparent and sized to this
// content by the main process, so the layout here is what the user sees floating
// over their desktop - nothing more. The Chat Panel (ticket 06) and Settings (ticket
// 13) menu targets open their windows; voice/reasoning/speech will later drive the
// state indicator, and a dev control drives it until then.
//
// While *Lune* is speaking, the pill's content is replaced by just the voice waveform (no
// "Lune" label). The spoken reply's text is NOT shown here; it reveals only beside the
// cursor on the Overlay. When the user is being heard (push-to-talk), the pill keeps its
// normal state dot + label - no waveform for the user's own voice.

const IS_DEV = import.meta.env.DEV;

export function Pill() {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const indicatorState = usePillStore((state) => state.indicatorState);
  const setIndicatorState = usePillStore((state) => state.setIndicatorState);
  // Lune is speaking: the pill collapses to just the waveform. The reply text itself shows
  // only at the cursor, never in the pill. (The user's own voice does NOT show a waveform.)
  const speaking = indicatorState === "speaking";

  // Background Task Agents: the Pill is their durable home, so a user who dismissed the stack
  // cards can still find (and re-open) their work here. A live badge counts running agents; the
  // menu entry brings the stack back.
  const { runningCount, totalCount } = useBackgroundTasks();

  // The pill is fixed in place (not draggable) and opens its menu on click. The bar is a
  // normal (no-drag) element so the click reliably registers - a `-webkit-app-region: drag`
  // region would swallow the DOM pointer events, which is why the old hover/click never
  // fired until a right-click jolted it.
  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);

  // Close the menu when the pill loses focus (the user clicked away to another app) or on
  // Escape, so it never stays stuck open once attention has moved elsewhere.
  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false);
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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
  // learn the current content size: on first paint, on every menu expand, and -
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

  // Re-measure whenever the menu opens/closes, whenever the pill's content switches between the
  // "Lune" label and the speaking waveform, AND whenever the background-task badge/entry appears
  // or its count changes width - so the frameless window always resizes to match with no dead
  // click region and no clipped badge.
  useLayoutEffect(() => {
    reportContentSize();
  }, [menuOpen, speaking, runningCount, totalCount, reportContentSize]);

  return (
    <div ref={wrapperRef} className="app-no-drag inline-flex flex-col items-center">
      {/* The chip: solid near-black, no border and no drop shadow (a shadow clipped by the
          content-sized transparent window reads as a grey box around the pill). Fixed in
          place; a click toggles the menu with a springy press. It keeps one consistent
          footprint (min width/height) whether it shows "Lune" or - while Lune is speaking -
          the green waveform, so the window shape never shrinks toward a square (which let a
          faint window-edge show around it). Never shows the reply text. */}
      <motion.div
        className="app-no-drag flex min-h-[40px] min-w-[96px] cursor-pointer select-none items-center justify-center gap-2 rounded-full bg-neutral-950/95 px-4 py-2.5 text-neutral-100"
        onClick={toggleMenu}
        whileTap={{ scale: 0.94 }}
        transition={{ type: "spring", stiffness: 600, damping: 18 }}
      >
        {speaking ? (
          // While Lune speaks, the green waveform is the pill's whole content. The reply
          // text never appears here (only at the cursor).
          <PillVoiceWave color={PILL_VOICE_WAVE_COLOR} prominent />
        ) : (
          <>
            <StateIndicator state={indicatorState} />
            <span className="text-sm font-medium tracking-wide">Lune</span>
            {/* A live count of running background agents, so the user knows work is underway
                even with the stack cards dismissed. Tapping the pill opens the menu to reach it. */}
            {runningCount > 0 && <BackgroundTaskBadge count={runningCount} />}
          </>
        )}
      </motion.div>

      <AnimatePresence onExitComplete={reportContentSize}>
        {menuOpen && (
          // The menu: solid black, no glass/backdrop-blur and no drop shadow (same clipped-
          // box reason as the bar), springing open on click with a lively bounce.
          <motion.div
            className="mt-2 w-56 origin-top overflow-hidden rounded-2xl bg-neutral-950 p-1.5 text-neutral-100"
            initial={{ opacity: 0, y: -10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 520, damping: 24, mass: 0.8 }}
          >
            {/* Background tasks live here so they outlast their stack cards: even after the
                cards are dismissed, this brings the stack back with every tracked session. Shown
                only when there's something to find. */}
            {totalCount > 0 && (
              <MenuButton
                label="Background tasks"
                badge={
                  <TaskCountChip
                    label={runningCount > 0 ? `${runningCount} running` : `${totalCount}`}
                    active={runningCount > 0}
                  />
                }
                onClick={() => {
                  setMenuOpen(false);
                  window.lune.agentStack.reveal();
                }}
              />
            )}
            {/* Opening a window collapses the menu behind it, so the Settings/Chat Panel
                surface never sits atop a leftover pill menu. */}
            <MenuButton
              label="Chat Panel"
              onClick={() => {
                setMenuOpen(false);
                window.lune.chatPanel.toggle();
              }}
            />
            <MenuButton
              label="Skills"
              onClick={() => {
                setMenuOpen(false);
                window.lune.skills.toggle();
              }}
            />
            <MenuButton
              label="Settings"
              onClick={() => {
                setMenuOpen(false);
                window.lune.settings.toggle();
              }}
            />
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

/** The pill's waveform colour while Lune speaks - a single warm green. */
const PILL_VOICE_WAVE_COLOR = "#34d399";

/** The heights each bar cycles through, offset per bar so the row ripples like a voice. */
const PILL_WAVE_BAR_HEIGHTS = ["4px", "12px", "6px", "11px", "4px"];
/** A taller cycle for the prominent (pill-filling) waveform when voice is the sole content. */
const PILL_WAVE_BAR_HEIGHTS_PROMINENT = ["5px", "17px", "9px", "15px", "5px"];

/**
 * A small animated waveform: a row of bars rising and falling, tinted to the active state.
 * `prominent` makes it larger with more bars, for when it is the pill's whole content while
 * a voice is flowing (rather than the compact leading glyph beside the "Lune" label).
 */
function PillVoiceWave({ color, prominent = false }: { color: string; prominent?: boolean }) {
  const bars = prominent ? [0, 1, 2, 3, 4] : [0, 1, 2, 3];
  const heights = prominent ? PILL_WAVE_BAR_HEIGHTS_PROMINENT : PILL_WAVE_BAR_HEIGHTS;
  return (
    <span
      className={`relative inline-flex items-center justify-center ${prominent ? "h-[17px] gap-[3px]" : "h-3 w-3 gap-[2px]"}`}
    >
      {bars.map((barIndex) => (
        <motion.span
          key={barIndex}
          className={`rounded-full ${prominent ? "w-[3px]" : "w-[2px]"}`}
          style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
          animate={{ height: heights }}
          transition={{
            duration: 0.9,
            repeat: Infinity,
            ease: "easeInOut",
            // Stagger each bar so the row ripples rather than pulsing in unison.
            delay: barIndex * 0.12,
          }}
        />
      ))}
    </span>
  );
}

/** A live menu row - pointer cursor, hover highlight, real action, and an optional trailing badge. */
function MenuButton({ label, onClick, badge }: { label: string; onClick: () => void; badge?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="app-no-drag flex w-full cursor-pointer items-center rounded-xl px-3 py-2 text-left text-sm text-neutral-100 transition hover:bg-white/10"
    >
      <span className="flex-1">{label}</span>
      {badge}
    </button>
  );
}

/** The pill-bar badge counting running background agents - a soft amber pulse matching the stack. */
function BackgroundTaskBadge({ count }: { count: number }) {
  return (
    <motion.span
      className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
      style={{ backgroundColor: "#fbbf2433", color: "#fbbf24" }}
      animate={{ opacity: [1, 0.55, 1] }}
      transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
    >
      {count}
    </motion.span>
  );
}

/** The count chip in the "Background tasks" menu row: amber while work runs, muted once idle. */
function TaskCountChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={active ? { backgroundColor: "#fbbf2433", color: "#fbbf24" } : { backgroundColor: "#ffffff1a", color: "#a3a3a3" }}
    >
      {label}
    </span>
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
