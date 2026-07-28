import type { TaskAgentSnapshot, TaskAgentStatus, TaskAgentStreamEvent } from "@lune/shared";

// The pure state + presentation logic behind the Agent Stack surface (M5-03): the reducer
// that folds the Task Agent event stream into the cards the surface renders, the classifier
// that decides what "open the result" means for a finished agent, and the view-model that
// turns a card into the words and tone the card shows. Kept free of React and IPC so the
// live-update, completion, and error behaviour is unit-tested without a window.
//
// One card per session, keyed by `sessionId`, so the stream of every concurrent agent
// multiplexes into one ordered list (start order) that the surface stacks top-down.

/** One Agent Stack card's state, folded from the session's event stream. */
export interface AgentCard {
  sessionId: string;
  /** The goal the card labels itself with. */
  goal: string;
  status: TaskAgentStatus;
  /** How many model steps have started - a live progress signal while running. */
  step: number;
  /** The latest human-readable activity line while running (a tool call or a said message). */
  activity?: string;
  /** The final summary, present only when `status` is `succeeded`. */
  result?: string;
  /** The readable failure reason, present only when `status` is `failed`. */
  error?: string;
}

/** Upserts the card for a session, applying a patch (and creating it if new). */
function upsert(
  cards: readonly AgentCard[],
  sessionId: string,
  patch: (card: AgentCard) => AgentCard,
  seed: () => AgentCard,
): AgentCard[] {
  const index = cards.findIndex((card) => card.sessionId === sessionId);
  if (index === -1) {
    return [...cards, patch(seed())];
  }
  const next = [...cards];
  next[index] = patch(next[index]!);
  return next;
}

/**
 * Folds one streamed Task Agent event into the card list, returning a new list (never
 * mutating). A `started` opens (or re-seeds) the card; `step-started` advances progress;
 * `message` and `tool-call` set the live activity line; the terminal events settle the card
 * with its result / error. An event for an unknown session other than `started` seeds a
 * minimal card defensively rather than dropping the update.
 */
export function reduceAgentCards(
  cards: readonly AgentCard[],
  event: TaskAgentStreamEvent,
): AgentCard[] {
  const seed = (): AgentCard => ({
    sessionId: event.sessionId,
    goal: "goal" in event ? event.goal : "",
    status: "running",
    step: 0,
  });
  switch (event.type) {
    case "started":
      return upsert(cards, event.sessionId, (card) => ({ ...card, goal: event.goal, status: "running", step: 0 }), seed);
    case "step-started":
      return upsert(cards, event.sessionId, (card) => ({ ...card, step: event.step }), seed);
    case "message":
      return upsert(cards, event.sessionId, (card) => ({ ...card, activity: event.text }), seed);
    case "tool-call":
      return upsert(cards, event.sessionId, (card) => ({ ...card, activity: describeToolCall(event.toolName, event.input) }), seed);
    case "tool-result":
      // The activity line already reflects the call; a result doesn't change what's shown.
      return upsert(cards, event.sessionId, (card) => card, seed);
    case "succeeded":
      return upsert(cards, event.sessionId, (card) => ({ ...card, status: "succeeded", result: event.result, activity: undefined }), seed);
    case "failed":
      return upsert(cards, event.sessionId, (card) => ({ ...card, status: "failed", error: event.message, activity: undefined }), seed);
    case "cancelled":
      return upsert(cards, event.sessionId, (card) => ({ ...card, status: "cancelled", activity: undefined }), seed);
  }
}

/** Builds a card from a point-in-time snapshot (used to seed the surface on mount). */
export function snapshotToCard(snapshot: TaskAgentSnapshot): AgentCard {
  return {
    sessionId: snapshot.sessionId,
    goal: snapshot.goal,
    status: snapshot.status,
    step: snapshot.step,
    result: snapshot.result,
    error: snapshot.error,
  };
}

/**
 * Seeds the card list from the runtime's current snapshots without clobbering cards the live
 * event stream has already produced: a session already present (from an event that arrived
 * during startup) keeps its event-sourced card, since events are newer than the one-shot
 * snapshot read. Only sessions the surface hasn't seen yet are added, preserving start order.
 */
export function seedAgentCards(
  cards: readonly AgentCard[],
  snapshots: readonly TaskAgentSnapshot[],
): AgentCard[] {
  const seen = new Set(cards.map((card) => card.sessionId));
  const seeded = snapshots.filter((snapshot) => !seen.has(snapshot.sessionId)).map(snapshotToCard);
  return [...seeded, ...cards];
}

/** Turns a tool call into a short, friendly present-tense activity line for the card. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const text = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  switch (toolName) {
    case "open_url":
      return `opening ${hostOf(text("url")) ?? "a link"}`;
    case "run_applescript":
      return "automating an app";
    case "run_shell_command": {
      const command = text("command");
      return command ? `running ${truncate(command, 40)}` : "running a command";
    }
    case "read_file":
      return "reading a file";
    case "write_file": {
      const filename = text("filename");
      return filename ? `writing ${filename}` : "writing a file";
    }
    case "web_search": {
      const query = text("query");
      return query ? `searching for ${truncate(query, 40)}` : "searching the web";
    }
    case "web_fetch":
      return "reading a page";
    default:
      return `using ${toolName}`;
  }
}

/** What clicking a finished card's result should do. */
export type ResultTarget =
  /** Open a file that was produced, in its default app. */
  | { kind: "file"; path: string }
  /** Open a URL in the browser. */
  | { kind: "url"; url: string }
  /** No openable artifact - the result is a text summary to read. */
  | { kind: "summary"; text: string };

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;
// An absolute POSIX path, captured (group 1) only when it is unambiguously one: it starts a
// token (line start or after whitespace/quote/paren), has at least two segments
// (`/dir/file.ext` - so a bare fraction like `/4.5` never matches), carries no whitespace,
// and ends in a short extension. Deliberately stricter than "any /…​.ext" because a wrong
// `openPath` is worse than a miss: an unrecognised path just degrades to a readable summary.
const FILE_PATH_PATTERN = /(?:^|[\s("'])(\/[^\s"'<>]+\/[^\s"'<>]*\.[A-Za-z0-9]{1,8})(?=[\s).,;:!?"']|$)/;

/** Trailing punctuation to peel off a URL captured from prose. */
function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?)\]}]+$/, "");
}

/**
 * Decides what "open the result" means for a finished agent by reading its summary text: a
 * URL it mentions opens in the browser, an unambiguous absolute file path opens the file, and
 * anything else is a summary to read on the card. A best-effort heuristic - the result is
 * natural language, so an unrecognised artifact degrades to `summary` (never a wrong open);
 * a URL is preferred over a path when both appear.
 */
export function classifyResult(result: string): ResultTarget {
  const url = result.match(URL_PATTERN);
  if (url) {
    return { kind: "url", url: trimTrailingPunctuation(url[0]) };
  }
  const path = result.match(FILE_PATH_PATTERN);
  if (path) {
    return { kind: "file", path: path[1]! };
  }
  return { kind: "summary", text: result };
}

/** The tone a card is rendered in, derived from its status. */
export type AgentCardTone = "working" | "done" | "error" | "dismissed";

/** The presentation of a card: the words and tone the surface shows, plus its open affordance. */
export interface AgentCardView {
  sessionId: string;
  goal: string;
  status: TaskAgentStatus;
  tone: AgentCardTone;
  /** The status headline - e.g. "done brewing" on success. */
  headline: string;
  /** The secondary line - live activity while running, the failure reason, or a result preview. */
  detail: string;
  /** Whether the card has settled (no more live updates). */
  isTerminal: boolean;
  /** The open target when the card is a finished success with something to open; else `null`. */
  openable: ResultTarget | null;
}

/** The playful completion headline (the ticket's "done brewing"). */
const DONE_HEADLINE = "done brewing";

/** Derives the view-model for a card: status → tone + headline, and the detail line + open target. */
export function deriveCardView(card: AgentCard): AgentCardView {
  const base = { sessionId: card.sessionId, goal: card.goal, status: card.status };
  switch (card.status) {
    case "running":
      return {
        ...base,
        tone: "working",
        headline: card.step > 0 ? `working (step ${card.step})` : "working",
        detail: card.activity ?? "getting started",
        isTerminal: false,
        openable: null,
      };
    case "succeeded": {
      const result = card.result ?? "";
      const openable = result.trim().length > 0 ? classifyResult(result) : null;
      return {
        ...base,
        tone: "done",
        headline: DONE_HEADLINE,
        detail: result.trim().length > 0 ? result : "all done",
        isTerminal: true,
        openable,
      };
    }
    case "failed":
      return {
        ...base,
        tone: "error",
        headline: "couldn't finish",
        detail: card.error ?? "something went wrong",
        isTerminal: true,
        openable: null,
      };
    case "cancelled":
      return {
        ...base,
        tone: "dismissed",
        headline: "stopped",
        detail: "dismissed",
        isTerminal: true,
        openable: null,
      };
  }
}

/** The host of a URL for a compact activity line, or `undefined` if it can't be parsed. */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Shortens a string to a preview with an ellipsis when it was cut. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
