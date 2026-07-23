import { useEffect, useRef } from "react";
import { usePillStore } from "./pillStore";

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

export function useSpeechPlayback(): void {
  const setIndicatorState = usePillStore((state) => state.setIndicatorState);

  // Refs (not state) so the queue/player survive re-renders without re-subscribing,
  // and the effect below runs exactly once.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  const setIndicatorStateRef = useRef(setIndicatorState);
  setIndicatorStateRef.current = setIndicatorState;

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    /** Starts the next queued clip, or returns the pill to idle when the queue is empty. */
    const playNext = (): void => {
      const nextUrl = queueRef.current.shift();
      if (nextUrl === undefined) {
        isPlayingRef.current = false;
        setIndicatorStateRef.current("idle");
        return;
      }
      isPlayingRef.current = true;
      setIndicatorStateRef.current("speaking");
      audio.src = nextUrl;
      void audio.play().catch((error) => {
        console.error("[lune] speech playback failed:", error);
        // Skip the un-playable clip so one bad clip never stalls the queue.
        handleClipFinished(nextUrl);
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
      for (const url of queueRef.current) {
        URL.revokeObjectURL(url);
      }
      queueRef.current = [];
    };

    /** Clears the queue and stops playback at once (failed turn, barge-in later). */
    const stopAll = (): void => {
      audio.pause();
      discardQueuedClips();
      isPlayingRef.current = false;
      setIndicatorStateRef.current("idle");
    };

    const unsubscribe = window.lune.speech.onSpeechEvent((event) => {
      switch (event.type) {
        case "clip": {
          queueRef.current.push(objectUrlFromBase64(event.audioBase64, event.contentType));
          if (!isPlayingRef.current) {
            playNext();
          }
          break;
        }
        case "turn-complete":
          // Nothing to do: the queue drains on its own and playNext returns to idle
          // after the last clip. (This event exists for a future "was anything spoken?"
          // decision; the sequential player needs no explicit end signal.)
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
    };
  }, []);
}
