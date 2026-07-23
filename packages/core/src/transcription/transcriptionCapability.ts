/**
 * The Core's Transcription Capability - the public batch entry point for on-device
 * speech-to-text (ADR-0003): a recorded WAV clip in, one transcript out. This is the
 * one Capability where the local path deliberately diverges from v1's streaming cloud
 * transcription - it is record -> transcribe -> transcript, no live partials - and in
 * Lune it is the only Transcription path (cloud speech vendors were dropped for M1).
 *
 * This is the successor of v1's HTTP-driven `localTranscriptionProvider` + the
 * `/transcribe` route, with HTTP removed: the Capability exposes a plain typed async
 * method the Electron main process calls directly (and a future HTTP adapter could
 * wrap). The Core owns no process and no transport - the main process injects the
 * whisper-server-backed transcribe call and the readiness signal; a test injects
 * stubs.
 *
 * Readiness has two independent requirements (ADR-0003, ADR-0006): the whisper
 * weights must be provisioned AND the whisper child Runtime must be started and
 * healthy. Until both hold, {@link transcribe} throws {@link TranscriptionNotReadyError}
 * before touching the Runtime, so the Shell surfaces "not ready" instead of hanging
 * on a dead Runtime - the typed successor of v1's 503.
 */
import type { TranscribeAudio, TranscriptionResult } from "./whisperTranscription.js";

/**
 * Thrown before any Runtime call when local Transcription isn't ready - the whisper
 * weights aren't provisioned yet, or the whisper child Runtime isn't started/healthy.
 * The typed successor of v1's 503 "not ready" for the gated local Transcription route.
 */
export class TranscriptionNotReadyError extends Error {
  constructor() {
    super("Local transcription (whisper) is not ready");
    this.name = "TranscriptionNotReadyError";
  }
}

/**
 * Thrown when an empty clip is submitted - there is nothing to transcribe. The typed
 * successor of v1's 400 for an empty `/transcribe` body; kept distinct from the
 * not-ready case so the Shell can tell "no audio captured" apart from "not ready".
 */
export class EmptyTranscriptionAudioError extends Error {
  constructor() {
    super("No audio to transcribe");
    this.name = "EmptyTranscriptionAudioError";
  }
}

/** The injected boundaries the Transcription Capability is built from. */
export interface TranscriptionCapabilityDependencies {
  /**
   * Whether local Transcription is ready right now: the whisper weights are
   * provisioned AND the whisper child Runtime is started and healthy. Read live on
   * every call so a weights download completing, or the Runtime coming up, takes
   * effect without rebuilding the Capability.
   */
  isRuntimeReady: () => boolean;
  /** The Provider -> Runtime call (stubbed in tests, real whisper-server in production). */
  transcribe: TranscribeAudio;
}

/** The Core's Transcription Capability: a single batch transcribe entry point. */
export interface TranscriptionCapability {
  /**
   * Transcribes one complete recorded WAV clip in a single shot and returns its
   * transcript (empty text for silence). Throws {@link TranscriptionNotReadyError}
   * (before any Runtime call) when local Transcription isn't ready, and
   * {@link EmptyTranscriptionAudioError} when the clip is empty.
   */
  transcribe(audioWav: Uint8Array): Promise<TranscriptionResult>;
  /** Whether local Transcription is ready to serve a clip right now (for status). */
  isReady(): boolean;
}

export function createTranscriptionCapability(
  dependencies: TranscriptionCapabilityDependencies,
): TranscriptionCapability {
  const { isRuntimeReady, transcribe } = dependencies;

  return {
    async transcribe(audioWav: Uint8Array): Promise<TranscriptionResult> {
      if (!isRuntimeReady()) {
        // Readiness-gating: not provisioned or the child isn't healthy -> throw
        // without touching the Runtime, so the Shell shows "not ready" over a hang.
        throw new TranscriptionNotReadyError();
      }
      if (audioWav.byteLength === 0) {
        throw new EmptyTranscriptionAudioError();
      }
      return transcribe(audioWav);
    },
    isReady(): boolean {
      return isRuntimeReady();
    },
  };
}
