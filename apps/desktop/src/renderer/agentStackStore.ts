import { create } from "zustand";
import type { TaskAgentSnapshot, TaskAgentStreamEvent } from "@lune/shared";
import {
  reduceAgentCards,
  seedAgentCards,
  type AgentCard,
} from "./agentCards";

// The Agent Stack's card state (M5-03), kept in a dedicated store so the surface only
// renders and the live wiring only calls actions. The reducer and seed logic are the pure,
// unit-tested functions in `agentStack.ts`; this store is the thin zustand shell around them,
// mirroring `pillStore`/`conversationStore`.

interface AgentStackState {
  /** One card per session, in start order - what the surface stacks top-down. */
  cards: AgentCard[];
  /** Seeds cards from the runtime's current snapshots on mount, without clobbering live ones. */
  seed: (snapshots: readonly TaskAgentSnapshot[]) => void;
  /** Folds one streamed Task Agent event into the cards. */
  applyEvent: (event: TaskAgentStreamEvent) => void;
  /** Removes a card from the surface (the session is cancelled separately, over IPC). */
  dismiss: (sessionId: string) => void;
}

export const useAgentStackStore = create<AgentStackState>((set) => ({
  cards: [],
  seed: (snapshots) => set((state) => ({ cards: seedAgentCards(state.cards, snapshots) })),
  applyEvent: (event) => set((state) => ({ cards: reduceAgentCards(state.cards, event) })),
  dismiss: (sessionId) => set((state) => ({ cards: state.cards.filter((card) => card.sessionId !== sessionId) })),
}));
