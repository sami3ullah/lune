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
  /**
   * Whether the user is holding push-to-talk (ticket 11): while true the Overlay shows
   * a live waveform near the cursor instead of the answer cursor, so the user can see
   * Lune is hearing them (user story 18).
   */
  listening: boolean;
  /** The latest mic input level (0..1) while listening, driving the waveform's height. */
  listeningLevel: number;

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
  /** Begins the listening waveform (push-to-talk held), resetting the level to zero. */
  beginListening: () => void;
  /** Updates the live waveform level (0..1) as the mic amplitude arrives. */
  setListeningLevel: (level: number) => void;
  /** Ends listening (the hotkey was released); the waveform gives way to the answer. */
  endListening: () => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  phase: "idle",
  answerText: "",
  pointTarget: null,
  showStreamingText: true,
  listening: false,
  listeningLevel: 0,

  // Starting an answer also clears any lingering listening waveform, so the surface
  // switches cleanly from "hearing you" to "answering".
  beginInteraction: () => set({ phase: "active", answerText: "", pointTarget: null, listening: false }),
  appendAnswer: (text) => set((state) => ({ answerText: state.answerText + text })),
  setPointTarget: (target) => set({ pointTarget: target }),
  endInteraction: () => set({ phase: "ending" }),
  reset: () => set({ phase: "idle", answerText: "", pointTarget: null, listening: false, listeningLevel: 0 }),
  setShowStreamingText: (showStreamingText) => set({ showStreamingText }),
  beginListening: () => set({ listening: true, listeningLevel: 0 }),
  setListeningLevel: (listeningLevel) => set({ listeningLevel }),
  endListening: () => set({ listening: false, listeningLevel: 0 }),
}));
