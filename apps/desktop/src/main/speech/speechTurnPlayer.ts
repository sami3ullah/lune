import type { SpeechCapability } from "@lune/core";
import type { SpeechEvent } from "../../ipc/speechPlayback";
import { SpeechSentenceChunker } from "./sentenceChunker";

/**
 * Drives Kokoro speech for one chat turn (ticket 09): it sentence-streams the answer
 * so the first sentence synthesizes and plays while later ones are still being
 * generated (user story 21 - first audio starts fast).
 *
 * As the Reasoning stream grows, the main process feeds the accumulated answer text
 * here; the chunker peels off each newly-completed sentence, and a single sequential
 * worker synthesizes them one at a time (preserving order) and emits each as a `clip`
 * event the moment its audio is ready. Because synthesis of sentence N runs while the
 * model is still streaming sentence N+1, audio begins well before the full answer
 * finishes. When the turn ends, the trailing (unterminated) sentence is flushed and,
 * once the queue drains, a `turn-complete` event lets the player return to idle.
 *
 * The synthesis boundary ({@link SpeechCapability}) and the event sink are injected,
 * so the ordering/pipelining behaviour is unit-tested against fakes.
 */
export interface SpeechTurnPlayerDependencies {
  /** The Core Speech Capability; each sentence is one `synthesize` call. */
  speech: SpeechCapability;
  /** The chat turn these clips belong to (tags every emitted event). */
  turnId: string;
  /** Where playback events go (production: IPC to the Pill renderer; tests: a spy). */
  sendEvent: (event: SpeechEvent) => void;
  /** Encodes synthesized audio bytes to base64 for the typed IPC payload. */
  encodeBase64: (audio: Uint8Array) => string;
  /**
   * Whether each clip should carry the sentence text it speaks, for the Pill's caption
   * line (the "show streaming text" setting). When false, clips carry an empty `text`
   * so the Pill shows no caption - voice only. Defaults to false.
   */
  includeCaption?: boolean;
  /**
   * The sequence number of the first emitted clip (defaults to 0). A voice turn that
   * already played an instant filler acknowledgement as sequence 0 starts its real
   * sentences at 1, keeping the per-turn sequence contract honest.
   */
  startSequence?: number;
  /** Optional error sink for a failed synthesis (defaults to console). */
  onError?: (error: unknown) => void;
}

export interface SpeechTurnPlayer {
  /**
   * Feeds the latest accumulated (Point-Tag-inclusive) answer text. Any sentences
   * that just completed are queued for synthesis. Safe to call on every stream delta.
   */
  pushAnswerText(accumulatedAnswer: string): void;
  /**
   * Signals the answer is complete: flushes the final sentence, then resolves once
   * every queued sentence has been synthesized and its `turn-complete` emitted.
   */
  finish(accumulatedAnswer: string): Promise<void>;
  /**
   * Halts this turn's speech at once (Barge-in / a failed turn): the worker stops
   * synthesizing and emits no further clips, so an interrupted turn can never keep
   * speaking after a newer turn has taken over. Idempotent; safe to call anytime.
   */
  stop(): void;
}

export function createSpeechTurnPlayer(
  dependencies: SpeechTurnPlayerDependencies,
): SpeechTurnPlayer {
  const { speech, turnId, sendEvent, encodeBase64 } = dependencies;
  const includeCaption = dependencies.includeCaption ?? false;
  const reportError = dependencies.onError ?? ((error) => console.error("[lune] speech synthesis failed:", error));

  const chunker = new SpeechSentenceChunker();
  const pendingSentences: string[] = [];
  let nextSequence = dependencies.startSequence ?? 0;
  // A single in-flight synthesis chain, so sentences are synthesized (and emitted) in
  // strict order even though `pushAnswerText` may enqueue several before the first
  // finishes. `null` when the worker is idle.
  let workerChain: Promise<void> | null = null;
  // Set once the answer is complete AND all queued sentences have drained, so the
  // worker can emit exactly one `turn-complete` at the very end.
  let answerComplete = false;
  let stopped = false;

  function enqueue(sentence: string): void {
    pendingSentences.push(sentence);
    ensureWorkerRunning();
  }

  function ensureWorkerRunning(): void {
    if (workerChain !== null) {
      return;
    }
    workerChain = runWorker().finally(() => {
      workerChain = null;
    });
  }

  async function runWorker(): Promise<void> {
    while (pendingSentences.length > 0) {
      if (stopped) {
        return;
      }
      const sentence = pendingSentences.shift()!;
      try {
        const result = await speech.synthesize(sentence);
        if (stopped) {
          return;
        }
        sendEvent({
          type: "clip",
          turnId,
          sequence: nextSequence,
          audioBase64: encodeBase64(result.audio),
          contentType: result.contentType,
          // The caption shows the sentence as it is spoken; trimmed so the Pill line is
          // clean. Empty when captions are off, so the Pill stays voice-only.
          text: includeCaption ? sentence.trim() : "",
        });
        nextSequence += 1;
      } catch (error) {
        // A synthesis failure (e.g. readiness flipped off mid-turn) stops this turn's
        // speech rather than failing the whole answer - the user still reads the text.
        reportError(error);
        stopped = true;
        return;
      }
    }
    // Emit the terminal event only after the answer is complete and nothing is queued,
    // so the renderer knows to idle once the last clip has played.
    if (answerComplete && !stopped) {
      sendEvent({ type: "turn-complete", turnId });
    }
  }

  return {
    pushAnswerText(accumulatedAnswer: string): void {
      if (stopped) {
        return;
      }
      for (const sentence of chunker.ingest(accumulatedAnswer)) {
        enqueue(sentence);
      }
    },

    async finish(accumulatedAnswer: string): Promise<void> {
      // Peel off any sentences completed by the final snapshot, then the trailing
      // unterminated remainder, before marking the answer done.
      if (!stopped) {
        for (const sentence of chunker.ingest(accumulatedAnswer)) {
          enqueue(sentence);
        }
        const remaining = chunker.flushRemaining(accumulatedAnswer);
        if (remaining !== undefined) {
          enqueue(remaining);
        }
      }

      answerComplete = true;
      // Wait for the worker to drain (and emit `turn-complete`). If the worker was
      // idle because no sentences were queued, emit the terminal event directly.
      if (workerChain !== null) {
        await workerChain;
      } else if (!stopped) {
        sendEvent({ type: "turn-complete", turnId });
      }
    },

    stop(): void {
      // Setting the flag halts the worker at its next `stopped` check and drops any
      // sentences still queued, so no more clips are emitted for this (interrupted) turn.
      stopped = true;
      pendingSentences.length = 0;
    },
  };
}
