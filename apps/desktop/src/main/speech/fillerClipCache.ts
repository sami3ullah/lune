import type { SpeechCapability } from "@lune/core";

// The instant-acknowledgement cache (perceived-latency fix): a voice turn takes a
// couple of seconds end to end (transcription + capture + the model's first sentence +
// synthesis), and until now Lune was silent the whole time. This pre-synthesizes a
// handful of short, warm filler acknowledgements ("hmm, let me see.") once Kokoro is
// ready, so the moment a voice turn starts the Shell can play one *instantly* - zero
// synthesis on the hot path - while the real answer is still being produced. The real
// answer's clips queue behind it on the same turn, so the handoff is seamless, and a
// Barge-in's `stop` cuts it like any other clip.
//
// The cache is keyed to the Voice it was synthesized with: a Voice change in Settings
// invalidates it and it re-primes with the new Voice. Priming failures degrade quietly -
// turns simply start without a filler, exactly as before this existed.

/** The short spoken acknowledgements, in Lune's lowercase, warm voice. Kept brief on
 * purpose: the real answer queues behind the filler, so every extra word here delays it. */
export const FILLER_PHRASES = [
  "mm-hm, let me see.",
  "okay, one sec.",
  "hmm, let me take a look.",
  "alright, one moment.",
  "sure, let me think.",
];

/** One ready-to-send filler clip (already base64, matching the speech IPC payload). */
export interface FillerClip {
  audioBase64: string;
  contentType: string;
}

export interface FillerClipCacheDependencies {
  /** The Core Speech Capability the fillers are synthesized through. */
  speech: SpeechCapability;
  /** The currently-selected Voice id; a change invalidates the cache. */
  getVoiceId: () => string;
  /** Encodes synthesized audio bytes to base64 for the typed IPC payload. */
  encodeBase64: (audio: Uint8Array) => string;
  /** The phrases to pre-synthesize (defaults to {@link FILLER_PHRASES}). */
  phrases?: string[];
  /** Picks which cached clip to play (injected so tests are deterministic). */
  pickIndex?: (clipCount: number) => number;
  /** Optional error sink for a failed priming (defaults to console). */
  onError?: (error: unknown) => void;
}

export interface FillerClipCache {
  /**
   * Ensures the cache is primed for the current Voice. Cheap and safe to call anytime
   * (turn start, boot, after Settings changes): it is a no-op while Kokoro isn't ready,
   * while priming is already running, or when the cache is already current.
   */
  prime(): void;
  /**
   * A filler clip for the current Voice, or `null` when none is ready (not yet primed,
   * Kokoro not ready, or the Voice just changed - in which case this re-primes for next
   * time). Never repeats the same clip twice in a row.
   */
  takeClip(): FillerClip | null;
}

export function createFillerClipCache(dependencies: FillerClipCacheDependencies): FillerClipCache {
  const { speech, getVoiceId, encodeBase64 } = dependencies;
  const phrases = dependencies.phrases ?? FILLER_PHRASES;
  const pickIndex =
    dependencies.pickIndex ?? ((clipCount: number) => Math.floor(Math.random() * clipCount));
  const reportError =
    dependencies.onError ?? ((error) => console.error("[lune] filler priming failed:", error));

  let cachedClips: FillerClip[] = [];
  let cachedVoiceId: string | null = null;
  let priming = false;
  let lastPlayedIndex = -1;

  function prime(): void {
    const voiceId = getVoiceId();
    if (priming || !speech.isReady() || (cachedVoiceId === voiceId && cachedClips.length > 0)) {
      return;
    }
    priming = true;
    void (async () => {
      const clips: FillerClip[] = [];
      try {
        // Sequential on purpose: Kokoro synthesis is CPU-bound, and priming is warm-up
        // work that must never contend with a live turn's first sentence.
        for (const phrase of phrases) {
          const result = await speech.synthesize(phrase);
          clips.push({
            audioBase64: encodeBase64(result.audio),
            contentType: result.contentType,
          });
        }
        cachedClips = clips;
        cachedVoiceId = voiceId;
        lastPlayedIndex = -1;
      } catch (error) {
        reportError(error);
      } finally {
        priming = false;
      }
    })();
  }

  return {
    prime,

    takeClip(): FillerClip | null {
      if (cachedVoiceId !== getVoiceId()) {
        // The Voice changed since priming: these clips are the wrong voice. Drop them
        // and re-prime; this turn just starts without a filler.
        cachedClips = [];
        cachedVoiceId = null;
        prime();
        return null;
      }
      if (cachedClips.length === 0) {
        return null;
      }
      // Never the same acknowledgement twice in a row (with 2+ clips), so consecutive
      // turns don't sound canned.
      let index = pickIndex(cachedClips.length);
      if (cachedClips.length > 1 && index === lastPlayedIndex) {
        index = (index + 1) % cachedClips.length;
      }
      lastPlayedIndex = index;
      return cachedClips[index]!;
    },
  };
}
