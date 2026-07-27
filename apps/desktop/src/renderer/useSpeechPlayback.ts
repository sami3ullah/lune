import { useEffect, useRef } from "react";
import { usePillStore } from "./pillStore";
import type { CaptionData } from "./caption";

// The renderer half of Kokoro speech playback (ticket 09). The main process
// synthesizes each sentence in-process and sends the WAV bytes as `clip` events; this
// hook - mounted once in the always-present Pill, which owns Lune's audio output -
// plays them back in order through a single audio element, so the first sentence's
// audio starts while later sentences are still being synthesized upstream.
//
// Playback is strictly sequential: a clip only begins once the previous one ends, so
// the sentences are never spoken over each other. While anything is playing or queued
// the pill shows the "speaking" state; it returns to idle once the queue drains after
// the turn completes (or immediately on a `stop`, e.g. a failed turn).

/** Decodes base64 audio bytes into a same-origin object URL an <audio> can play. */
function objectUrlFromBase64(audioBase64: string, contentType: string): string {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: contentType }));
}

/** A synthesized clip queued for playback: its playable audio URL and the line it speaks. */
interface QueuedClip {
  audioUrl: string;
  /** The sentence this clip speaks, shown as the Pill caption while it plays ("" = none). */
  text: string;
}

export function useSpeechPlayback(): void {
  const setIndicatorState = usePillStore((state) => state.setIndicatorState);
  const setCaption = usePillStore((state) => state.setCaption);

  // Refs (not state) so the queue/player survive re-renders without re-subscribing,
  // and the effect below runs exactly once.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<QueuedClip[]>([]);
  const isPlayingRef = useRef(false);
  // The turn whose clips we're currently playing, and the turns we've abandoned (a
  // Barge-in superseded them). Together these make playback turn-aware so an interrupted
  // turn's late-arriving clips are never played over the new turn - the core of "no zombie
  // audio". Abandoned ids are kept for the session so a very-late stale clip stays ignored.
  const currentTurnIdRef = useRef<string | null>(null);
  const abandonedTurnIdsRef = useRef<Set<string>>(new Set());
  // The turns whose `turn-complete` has arrived: no more clips are coming for them. Lets
  // the player tell "the queue drained because the answer is over" (return to idle) apart
  // from "the queue drained mid-turn" - e.g. the instant filler acknowledgement finished
  // before the first real sentence was synthesized - where it shows "thinking" and waits.
  const completedTurnIdsRef = useRef<Set<string>>(new Set());
  const setIndicatorStateRef = useRef(setIndicatorState);
  setIndicatorStateRef.current = setIndicatorState;

  // The word-by-word reveal of the sentence currently playing, and a monotonic counter
  // that gives each sentence a stable id (so the reveal component restarts cleanly per
  // sentence). The reveal is paced by the audio clock (see `revealTick` in the effect),
  // not a fixed timer, so the words appear in step with the voice even if playback is slow
  // to start or briefly stalls; `captionTimerRef` holds that pacing interval.
  const captionRevealRef = useRef<{ id: string; words: string[]; revealed: number } | null>(null);
  const captionSeqRef = useRef(0);
  const captionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Emit the current caption to the Pill store AND mirror it onto the Overlay (beside the
  // cursor), so the same word-by-word reveal shows in both places in step with the voice.
  // Kept behind one ref so the playback effect below runs exactly once. `null` clears both.
  const emitCaptionRef = useRef<(caption: CaptionData | null) => void>(() => {});
  emitCaptionRef.current = (caption: CaptionData | null) => {
    setCaption(caption);
    window.lune.pill.reportCaption(
      caption === null ? { id: "", words: [] } : { id: caption.id, words: caption.words },
    );
  };

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    // Reveal the playing sentence's words in step with the audio clock: the number of
    // words shown tracks how far playback has progressed, so they appear as the voice
    // speaks them (and the last word lands as the clip ends). Re-derived each tick so it
    // self-corrects if playback is slow to start or briefly stalls.
    const revealTick = (): void => {
      const reveal = captionRevealRef.current;
      if (reveal === null) {
        return;
      }
      const duration = audio.duration;
      let targetCount: number;
      if (!Number.isFinite(duration) || duration <= 0) {
        // Duration not known yet (metadata still loading): keep the first word showing.
        targetCount = 1;
      } else {
        const progress = Math.min(1, Math.max(0, audio.currentTime / duration));
        targetCount = Math.min(reveal.words.length, Math.floor(progress * reveal.words.length) + 1);
      }
      if (targetCount !== reveal.revealed) {
        reveal.revealed = targetCount;
        emitCaptionRef.current({ id: reveal.id, words: reveal.words.slice(0, targetCount) });
      }
    };
    captionTimerRef.current = setInterval(revealTick, 60);

    /** Starts the next queued clip, or settles the pill when the queue is empty. */
    const playNext = (): void => {
      const nextClip = queueRef.current.shift();
      if (nextClip === undefined) {
        isPlayingRef.current = false;
        // Drained mid-turn (its `turn-complete` hasn't arrived): more clips are still
        // being synthesized upstream - the filler acknowledgement outran the first real
        // sentence. Show "thinking" and keep the turn current so its next clip resumes.
        const drainedTurnId = currentTurnIdRef.current;
        if (drainedTurnId !== null && !completedTurnIdsRef.current.has(drainedTurnId)) {
          setIndicatorStateRef.current("thinking");
          captionRevealRef.current = null;
          emitCaptionRef.current(null);
          return;
        }
        currentTurnIdRef.current = null;
        setIndicatorStateRef.current("idle");
        // The whole answer has finished speaking: clear the caption so the Pill returns
        // to its resting state exactly when the voice stops (not on a fixed timeout).
        captionRevealRef.current = null;
        emitCaptionRef.current(null);
        return;
      }
      isPlayingRef.current = true;
      setIndicatorStateRef.current("speaking");
      // Begin this sentence's word-by-word reveal as its audio starts, so the answer reads
      // out in step with the voice. An empty text (captions off) shows nothing.
      const words = nextClip.text.trim().length > 0 ? nextClip.text.trim().split(/\s+/) : [];
      if (words.length === 0) {
        captionRevealRef.current = null;
        emitCaptionRef.current(null);
      } else {
        captionSeqRef.current += 1;
        const captionId = `caption-${captionSeqRef.current}`;
        captionRevealRef.current = { id: captionId, words, revealed: 1 };
        // Show the first word immediately so the reveal starts the instant audio begins,
        // rather than only on the next pacing tick.
        emitCaptionRef.current({ id: captionId, words: words.slice(0, 1) });
      }
      audio.src = nextClip.audioUrl;
      void audio.play().catch((error) => {
        console.error("[lune] speech playback failed:", error);
        // Skip the un-playable clip so one bad clip never stalls the queue.
        handleClipFinished(nextClip.audioUrl);
      });
    };

    /** Revokes a finished clip's URL and advances to the next. */
    const handleClipFinished = (finishedUrl: string): void => {
      URL.revokeObjectURL(finishedUrl);
      playNext();
    };

    const handleEnded = (): void => {
      // `audio.src` is a resolved absolute URL by now; the object URL we set is what
      // was current, so revoke via the current src.
      handleClipFinished(audio.src);
    };
    audio.addEventListener("ended", handleEnded);

    /** Revokes and drops every still-queued clip URL. */
    const discardQueuedClips = (): void => {
      for (const clip of queueRef.current) {
        URL.revokeObjectURL(clip.audioUrl);
      }
      queueRef.current = [];
    };

    /** Clears the queue and stops playback at once (failed turn, barge-in). */
    const stopAll = (): void => {
      audio.pause();
      discardQueuedClips();
      // Abandon the turn being played so any of its clips still in flight are ignored.
      if (currentTurnIdRef.current !== null) {
        abandonedTurnIdsRef.current.add(currentTurnIdRef.current);
        currentTurnIdRef.current = null;
      }
      isPlayingRef.current = false;
      setIndicatorStateRef.current("idle");
      captionRevealRef.current = null;
      emitCaptionRef.current(null);
    };

    const unsubscribe = window.lune.speech.onSpeechEvent((event) => {
      switch (event.type) {
        case "clip": {
          // A superseded (interrupted) turn's clip: never play it over the newer turn.
          if (abandonedTurnIdsRef.current.has(event.turnId)) {
            break;
          }
          // A clip from a different turn than the one we're playing means a new turn has
          // taken over (Barge-in): abandon the old turn and drop its still-queued clips so
          // only the new turn is heard.
          if (currentTurnIdRef.current !== null && currentTurnIdRef.current !== event.turnId) {
            abandonedTurnIdsRef.current.add(currentTurnIdRef.current);
            audio.pause();
            discardQueuedClips();
            isPlayingRef.current = false;
            currentTurnIdRef.current = null;
          }
          if (currentTurnIdRef.current === null) {
            currentTurnIdRef.current = event.turnId;
          }
          queueRef.current.push({
            audioUrl: objectUrlFromBase64(event.audioBase64, event.contentType),
            text: event.text,
          });
          if (!isPlayingRef.current) {
            playNext();
          }
          break;
        }
        case "turn-complete":
          // No more clips are coming for this turn. Usually the queue is still playing
          // and playNext settles to idle after the last clip; but if the queue already
          // drained mid-turn (the player is holding in "thinking" after a filler), there
          // is nothing left to wait for - settle to idle now.
          completedTurnIdsRef.current.add(event.turnId);
          if (!isPlayingRef.current && currentTurnIdRef.current === event.turnId) {
            currentTurnIdRef.current = null;
            setIndicatorStateRef.current("idle");
            captionRevealRef.current = null;
            emitCaptionRef.current(null);
          }
          break;
        case "stop":
          stopAll();
          break;
      }
    });

    return () => {
      unsubscribe();
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
      discardQueuedClips();
      if (captionTimerRef.current !== null) {
        clearInterval(captionTimerRef.current);
        captionTimerRef.current = null;
      }
    };
  }, []);
}
