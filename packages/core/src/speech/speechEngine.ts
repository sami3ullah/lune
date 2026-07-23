/**
 * The Core's local Speech seam: the `KokoroSpeechEngine` interface the Speech
 * Capability depends on, plus its request/result types and the deferred test-double
 * engine. Carried from v1's `kokoroSpeechEngine.ts` (ADR-0004), with HTTP removed.
 *
 * This is the one Speech boundary the Core keeps injected (spec: no new seams are
 * invented for M1). The real audio-producing engine - in-process ONNX via
 * onnxruntime-node with espeak phonemization - lives in the Electron main process
 * (`apps/desktop/src/main/speech/nodeKokoroSpeechEngine.ts`), never in @lune/core, so
 * the Core stays pure and testable without shipping the multi-gigabyte weights. Tests
 * inject a stub or the deferred engine below.
 */

/** A request to synthesize one chunk of text (typically one sentence). */
export interface SpeechSynthesisRequest {
  /** The text to speak. */
  text: string;
  /** The Kokoro Voice to synthesize with (one of `KOKORO_VOICES`). */
  voice: string;
}

/** Synthesized audio plus the MIME type the Shell should play it as. */
export interface SpeechSynthesisResult {
  audio: Uint8Array;
  contentType: string;
}

/**
 * The Capability -> Runtime seam for local Speech. A real implementation loads the
 * Kokoro ONNX model and voice embeddings and runs inference; the deferred
 * implementation below reports not-ready. The Speech Capability depends only on this
 * interface, so swapping in the real engine is a construction change.
 */
export interface KokoroSpeechEngine {
  /** Whether the model weights are present and loaded so synthesis can run. */
  isReady(): boolean;
  /** Synthesizes audio for the request. Rejects with `SpeechEngineNotReadyError` when not ready. */
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
}

/** Thrown when synthesis is attempted before the Runtime's weights are ready. */
export class SpeechEngineNotReadyError extends Error {
  constructor(message = "Kokoro Speech Runtime is not ready") {
    super(message);
    this.name = "SpeechEngineNotReadyError";
  }
}

/**
 * A deferred, always-not-ready engine used as a test double where synthesis isn't
 * the subject (e.g. readiness/gating tests). Production uses the real engine in the
 * Electron main process.
 */
export function createDeferredKokoroSpeechEngine(): KokoroSpeechEngine {
  return {
    isReady: () => false,
    synthesize: () => Promise.reject(new SpeechEngineNotReadyError()),
  };
}
