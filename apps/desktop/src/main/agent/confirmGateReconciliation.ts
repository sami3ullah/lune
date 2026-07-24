// The Confirm Gate's fail-safe reconciliation (M2-04, ported from v1 ticket 18): the pure
// logic that combines the answers arriving from every modality (the on-screen chip, the
// hotkey, and voice) into one decision, under the load-bearing safety asymmetry that keeps
// voice off the critical failure path. It is a named pure-logic seam like
// `PushToTalkTracker` / `VoiceLoopMachine`, tested without any chip, mic, or hotkey, so the
// controller that drives the real edges (`confirmGateController`) stays a thin coordinator.
//
// Two rules carry the safety guarantee:
//
//   - Any cancel always beats a concurrent approve. Chip Cancel, the Esc/abort hotkey, and
//     a clearly-negative utterance are all cancels; if any is present the gate cancels,
//     regardless of a competing approve (cancel wins every race).
//   - Voice can only ever *approve* on an unambiguous affirmative. A mumbled or unclear
//     reply is an abstain, never an approve - so an ambiguous utterance re-prompts and can
//     never turn into a go on a `consequential` Action.

/** One normalized vote toward a gate decision, distilled from a single modality's answer. */
export type GateVote =
  /** An explicit go-ahead (chip Approve, the approve hotkey, an unambiguous affirmative). */
  | "approve"
  /** An explicit stop (chip Cancel, Esc/abort hotkey, a clearly-negative utterance). */
  | "cancel"
  /** No decision this modality is willing to stake a go on (an ambiguous voice reply). */
  | "abstain";

/** The decision the gate reaches from the votes gathered so far. */
export type GateDecision =
  /** Proceed with the pending Action. */
  | "approve"
  /** Stop: end the session without the pending Action. */
  | "cancel"
  /** Nothing decisive yet - ask again and keep listening (never a silent proceed). */
  | "reprompt";

/**
 * Reconciles every vote gathered so far into a single decision. Cancel dominates (any
 * cancel wins over any approve), then an explicit approve proceeds, and otherwise - only
 * abstains, or nothing yet - the gate re-prompts rather than ever proceeding on its own.
 * Pure and order-independent: the same set of votes always yields the same decision.
 */
export function reconcileGateSignals(votes: readonly GateVote[]): GateDecision {
  if (votes.includes("cancel")) {
    return "cancel";
  }
  if (votes.includes("approve")) {
    return "approve";
  }
  return "reprompt";
}

/** How a spoken gate answer was understood; drives {@link voteForUtterance}. */
export type ConfirmUtteranceIntent =
  /** A clear yes ("yes", "go ahead", "do it"). */
  | "affirmative"
  /** A clear no or stop ("no", "stop", "cancel", "don't"). */
  | "negative"
  /** Anything unclear (silence, filler, a muddled reply) - never counts as a go. */
  | "ambiguous";

/**
 * The clear-stop cues. A reply carrying any of these is a negative, even alongside an
 * affirmative cue ("yeah, no, don't") - the fail-safe asymmetry means a stop is never
 * overridden by a yes in the same breath.
 */
const NEGATIVE_WORDS = new Set([
  "no",
  "nope",
  "nah",
  "stop",
  "cancel",
  "cancelled",
  "don't",
  "dont",
  "abort",
  "halt",
  "quit",
  "nevermind",
]);
// Note: hesitations like "wait" / "hold on" are deliberately NOT clear stops - they fall
// through to ambiguous and re-prompt (the friendly fail-safe), rather than ending the
// whole session the way a decisive "no" / "cancel" / "stop" does.

/** Multi-word clear-stop cues, matched against the normalized (single-spaced) phrase. */
const NEGATIVE_PHRASES = ["never mind"];

/** The clear-go cues. Only these (with no negative present) make an utterance affirmative. */
const AFFIRMATIVE_WORDS = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "yay",
  "sure",
  "ok",
  "okay",
  "okey",
  "go",
  "proceed",
  "confirm",
  "confirmed",
  "affirmative",
  "continue",
]);

/** Multi-word clear-go cues, matched against the normalized (single-spaced) phrase. */
const AFFIRMATIVE_PHRASES = ["go ahead", "do it", "please do", "sounds good", "carry on"];

/** Lowercases, and reduces the transcript to space-separated word tokens (letters + apostrophes). */
function normalize(transcript: string): { phrase: string; tokens: string[] } {
  const tokens = transcript
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter((token) => token.length > 0);
  return { phrase: tokens.join(" "), tokens };
}

/**
 * Classifies a spoken gate answer as affirmative / negative / ambiguous, matching whole
 * words (so "know" is never "no", "goes" is never "go") and honouring the fail-safe
 * asymmetry: any clear stop cue makes the whole reply negative, an affirmative needs a
 * clear go cue and no stop cue, and everything else is ambiguous (which re-prompts and
 * never approves). Pure over the transcript.
 */
export function classifyConfirmUtterance(transcript: string): ConfirmUtteranceIntent {
  const { phrase, tokens } = normalize(transcript);
  if (tokens.length === 0) {
    return "ambiguous";
  }

  const hasNegative =
    tokens.some((token) => NEGATIVE_WORDS.has(token)) ||
    NEGATIVE_PHRASES.some((negativePhrase) => phrase.includes(negativePhrase));
  if (hasNegative) {
    return "negative";
  }

  // A bare "not" (not caught above as a clear stop) negates any affirmative cue: "not sure",
  // "not yet" must never approve. We treat it as ambiguous rather than a cancel - the user is
  // hesitating, not declining, so the friendly fail-safe is to re-prompt, never to proceed.
  if (tokens.includes("not")) {
    return "ambiguous";
  }

  const hasAffirmative =
    tokens.some((token) => AFFIRMATIVE_WORDS.has(token)) ||
    AFFIRMATIVE_PHRASES.some((affirmativePhrase) => phrase.includes(affirmativePhrase));
  return hasAffirmative ? "affirmative" : "ambiguous";
}

/**
 * Maps a classified voice intent onto a reconciliation {@link GateVote}: an affirmative is
 * an approve, a negative is a cancel (which then wins every race), and an ambiguous reply
 * abstains - so it can only ever re-prompt, never approve.
 */
export function voteForUtterance(intent: ConfirmUtteranceIntent): GateVote {
  switch (intent) {
    case "affirmative":
      return "approve";
    case "negative":
      return "cancel";
    case "ambiguous":
      return "abstain";
  }
}
