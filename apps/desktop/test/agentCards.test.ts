import { describe, expect, it } from "vitest";
import type { TaskAgentStreamEvent } from "@lune/shared";

import {
  classifyResult,
  deriveCardView,
  describeToolCall,
  reduceAgentCards,
  seedAgentCards,
  snapshotToCard,
  type AgentCard,
} from "../src/renderer/agentCards";

// The pure Agent Stack logic (M5-03): folding the event stream into cards, deciding what
// "open the result" means, and turning a card into the words/tone shown. No React, no IPC.

function started(sessionId: string, goal: string): TaskAgentStreamEvent {
  return { type: "started", sessionId, goal, ipcVersion: 5 };
}

describe("reduceAgentCards", () => {
  it("opens one card per session and keeps them in start order", () => {
    let cards: AgentCard[] = [];
    cards = reduceAgentCards(cards, started("a", "goal A"));
    cards = reduceAgentCards(cards, started("b", "goal B"));
    expect(cards.map((card) => card.sessionId)).toEqual(["a", "b"]);
    expect(cards[0]).toMatchObject({ goal: "goal A", status: "running", step: 0 });
  });

  it("multiplexes three concurrent sessions without crosstalk", () => {
    let cards: AgentCard[] = [];
    for (const id of ["a", "b", "c"]) {
      cards = reduceAgentCards(cards, started(id, `goal ${id}`));
    }
    cards = reduceAgentCards(cards, { type: "step-started", sessionId: "b", step: 2 });
    cards = reduceAgentCards(cards, { type: "succeeded", sessionId: "c", result: "done C" });
    expect(cards.find((card) => card.sessionId === "b")).toMatchObject({ step: 2, status: "running" });
    expect(cards.find((card) => card.sessionId === "c")).toMatchObject({ status: "succeeded", result: "done C" });
    expect(cards.find((card) => card.sessionId === "a")).toMatchObject({ status: "running", step: 0 });
  });

  it("tracks live activity from messages and tool calls, then clears it on completion", () => {
    let cards = reduceAgentCards([], started("a", "g"));
    cards = reduceAgentCards(cards, { type: "tool-call", sessionId: "a", step: 1, toolCallId: "t1", toolName: "open_url", input: { url: "https://example.com/x" } });
    expect(cards[0]!.activity).toBe("opening example.com");
    cards = reduceAgentCards(cards, { type: "message", sessionId: "a", step: 1, text: "almost there" });
    expect(cards[0]!.activity).toBe("almost there");
    cards = reduceAgentCards(cards, { type: "succeeded", sessionId: "a", result: "ok" });
    expect(cards[0]!.activity).toBeUndefined();
  });

  it("settles failed and cancelled cards with their reasons", () => {
    let cards = reduceAgentCards([], started("a", "g"));
    cards = reduceAgentCards(cards, { type: "failed", sessionId: "a", message: "rate limited" });
    expect(cards[0]).toMatchObject({ status: "failed", error: "rate limited" });

    let other = reduceAgentCards([], started("b", "g"));
    other = reduceAgentCards(other, { type: "cancelled", sessionId: "b" });
    expect(other[0]).toMatchObject({ status: "cancelled" });
  });

  it("does not mutate the previous card list", () => {
    const before = reduceAgentCards([], started("a", "g"));
    const after = reduceAgentCards(before, { type: "step-started", sessionId: "a", step: 1 });
    expect(before[0]!.step).toBe(0);
    expect(after[0]!.step).toBe(1);
  });
});

describe("seedAgentCards", () => {
  it("seeds cards from snapshots on an empty surface, in snapshot order", () => {
    const cards = seedAgentCards([], [
      { sessionId: "a", goal: "A", status: "running", step: 1 },
      { sessionId: "b", goal: "B", status: "succeeded", step: 3, result: "done" },
    ]);
    expect(cards.map((card) => card.sessionId)).toEqual(["a", "b"]);
    expect(cards[1]).toMatchObject({ status: "succeeded", result: "done" });
  });

  it("never clobbers an event-sourced card with an older snapshot for the same session", () => {
    const live: AgentCard[] = [{ sessionId: "a", goal: "A", status: "succeeded", step: 3, result: "fresh" }];
    const seeded = seedAgentCards(live, [{ sessionId: "a", goal: "A", status: "running", step: 1 }]);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ status: "succeeded", result: "fresh" });
  });
});

describe("snapshotToCard", () => {
  it("carries a failed snapshot's error onto the card", () => {
    expect(snapshotToCard({ sessionId: "a", goal: "g", status: "failed", step: 2, error: "boom" })).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });
});

describe("describeToolCall", () => {
  it("renders friendly present-tense lines per tool", () => {
    expect(describeToolCall("open_url", { url: "https://open.spotify.com/track/x" })).toBe("opening open.spotify.com");
    expect(describeToolCall("run_shell_command", { command: "ls -la" })).toBe("running ls -la");
    expect(describeToolCall("write_file", { filename: "note.md" })).toBe("writing note.md");
    expect(describeToolCall("web_search", { query: "berlin weather" })).toBe("searching for berlin weather");
    expect(describeToolCall("mystery", {})).toBe("using mystery");
  });
});

describe("classifyResult", () => {
  it("prefers a URL when the summary mentions one", () => {
    expect(classifyResult("I opened https://example.com/page for you.")).toEqual({
      kind: "url",
      url: "https://example.com/page",
    });
  });

  it("finds an unambiguous absolute file path and strips the trailing sentence period", () => {
    expect(classifyResult("Saved to /Users/me/Documents/Lune/shopping-list.md.")).toEqual({
      kind: "file",
      path: "/Users/me/Documents/Lune/shopping-list.md",
    });
  });

  it("does not false-positive on a fraction-like token (no wrong openPath)", () => {
    // "/4.5" is a single-segment slash token mid-word - not a real path; must stay a summary.
    expect(classifyResult("The aspect ratio is 3/4.5 overall.")).toEqual({
      kind: "summary",
      text: "The aspect ratio is 3/4.5 overall.",
    });
  });

  it("falls back to a summary when there's no openable artifact", () => {
    expect(classifyResult("It is sunny and 24 degrees in Berlin.")).toEqual({
      kind: "summary",
      text: "It is sunny and 24 degrees in Berlin.",
    });
  });
});

describe("deriveCardView", () => {
  it("shows a live working headline with the activity detail", () => {
    const view = deriveCardView({ sessionId: "a", goal: "do it", status: "running", step: 2, activity: "running ls -la" });
    expect(view).toMatchObject({ tone: "working", headline: "working (step 2)", detail: "running ls -la", isTerminal: false, openable: null });
  });

  it("shows 'done brewing' and an open target on success", () => {
    const view = deriveCardView({ sessionId: "a", goal: "note", status: "succeeded", step: 3, result: "Saved to /Users/me/Documents/Lune/note.md." });
    expect(view.tone).toBe("done");
    expect(view.headline).toBe("done brewing");
    expect(view.isTerminal).toBe(true);
    expect(view.openable).toEqual({ kind: "file", path: "/Users/me/Documents/Lune/note.md" });
  });

  it("renders a failure as a readable error with no open target", () => {
    const view = deriveCardView({ sessionId: "a", goal: "x", status: "failed", step: 1, error: "Google Gemini credentials are not configured" });
    expect(view.tone).toBe("error");
    expect(view.headline).toBe("couldn't finish");
    expect(view.detail).toContain("credentials");
    expect(view.openable).toBeNull();
  });
});
