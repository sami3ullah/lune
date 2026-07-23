import { create } from "zustand";

/**
 * What Lune is doing, shown at a glance on the pill (user story 15), in display
 * order. These are the five surface states the spec names; the real transitions
 * arrive with voice, reasoning, and speech in later tickets. Until then a dev
 * control drives them. The union type below is derived from this one list so a new
 * state is added in exactly one place.
 */
export const PILL_INDICATOR_STATES = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "needs-attention",
] as const;

export type PillIndicatorState = (typeof PILL_INDICATOR_STATES)[number];

interface PillState {
  indicatorState: PillIndicatorState;
  setIndicatorState: (state: PillIndicatorState) => void;
}

// A dedicated store (rather than local component state) so that when the real
// states arrive - driven by the voice loop, the reasoning stream, and Kokoro
// playback over IPC - they only need to call `setIndicatorState`, with no change to
// the pill's rendering.
export const usePillStore = create<PillState>((set) => ({
  indicatorState: "idle",
  setIndicatorState: (indicatorState) => set({ indicatorState }),
}));
