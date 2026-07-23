import { create } from "zustand";

// The Overlay's interaction state (ticket 07). One Overlay window per display runs
// this store; the main process drives it over IPC (activity, streamed answer text, a
// pointing target). The component reads this to render the cursor + bubble and to
// decide when to fade. Kept as a plain store (like pillStore/conversationStore) so the
// streaming-text flag has one home for ticket 13's Settings toggle to flip.

/** A pointing target in this window's display-local coordinate space. */
export interface OverlayPointTarget {
  x: number;
  y: number;
  /** The short phrase the model attached to the target ("Save button"). */
  label: string;
}

/** Where the current interaction is: dormant, or mid/just-finished an answer. */
export type OverlayPhase = "idle" | "active" | "ending";

interface OverlayState {
  phase: OverlayPhase;
  /** The clean answer text streamed so far (the Point Tag already stripped by main). */
  answerText: string;
  /** The element to fly to and point at, or `null` when this turn doesn't point. */
  pointTarget: OverlayPointTarget | null;
  /**
   * Whether the response bubble is shown. Wired to the "show streaming text" Setting
   * in ticket 13; until then it defaults on. When off, the cursor still flies and
   * points, but the streamed answer text is not displayed (voice-only preference).
   */
  showStreamingText: boolean;

  /** Begins an interaction: clears the previous answer/target and shows the cursor. */
  beginInteraction: () => void;
  /** Appends a chunk of streamed (already tag-stripped) answer text to the bubble. */
  appendAnswer: (text: string) => void;
  /** Sets the element the cursor should fly to and point at. */
  setPointTarget: (target: OverlayPointTarget) => void;
  /** Marks the answer complete; the component's inactivity timer then fades it out. */
  endInteraction: () => void;
  /** Returns to fully-dormant once the fade-out has finished. */
  reset: () => void;
  /** Sets the streaming-text visibility (ticket 13's Settings toggle). */
  setShowStreamingText: (showStreamingText: boolean) => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  phase: "idle",
  answerText: "",
  pointTarget: null,
  showStreamingText: true,

  beginInteraction: () => set({ phase: "active", answerText: "", pointTarget: null }),
  appendAnswer: (text) => set((state) => ({ answerText: state.answerText + text })),
  setPointTarget: (target) => set({ pointTarget: target }),
  endInteraction: () => set({ phase: "ending" }),
  reset: () => set({ phase: "idle", answerText: "", pointTarget: null }),
  setShowStreamingText: (showStreamingText) => set({ showStreamingText }),
}));
