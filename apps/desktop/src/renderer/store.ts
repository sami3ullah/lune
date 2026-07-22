import { create } from "zustand";
import type { PingResponse } from "@lune/shared";

interface WiringProofState {
  lastPingResponse: PingResponse | null;
  recordPingResponse: (pingResponse: PingResponse) => void;
}

// A minimal Zustand store that only proves state management is wired into the
// renderer. Real app state (voice status, conversation history, Pill state, ...)
// arrives in later tickets.
export const useWiringProofStore = create<WiringProofState>((set) => ({
  lastPingResponse: null,
  recordPingResponse: (pingResponse) => set({ lastPingResponse: pingResponse }),
}));
