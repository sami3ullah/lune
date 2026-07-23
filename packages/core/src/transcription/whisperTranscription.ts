/**
 * The Provider -> Runtime seam for local Transcription (ADR-0003): how the Core's
 * Transcription Capability hands a recorded push-to-talk clip to the whisper.cpp
 * child Runtime and gets back a transcript.
 *
 * Local Transcription is **batch-on-release**, not streaming: the Shell records the
 * whole clip and hands it to the Core once on hotkey release, and whisper.cpp
 * (large-v3-turbo, Metal) transcribes it in one shot. So this seam is a single call,
 * not a stream. Modelling it as an injectable function lets the Core tests stub the
 * Runtime boundary - no whisper binary or model weights needed - while the real
 * implementation (`nodeWhisperRuntime.ts` in the Electron main process) talks to the
 * running whisper-server child.
 */

/** The transcript produced from one audio clip. */
export interface TranscriptionResult {
  /** The recognized text (may be empty for silence). */
  text: string;
}

/**
 * Transcribes one complete audio clip in a single shot. `audioWav` is the recorded
 * WAV bytes the Shell captured. Rejects if the Runtime can't produce a transcript.
 */
export type TranscribeAudio = (audioWav: Uint8Array) => Promise<TranscriptionResult>;
