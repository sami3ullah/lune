import fs from "node:fs/promises";
import path from "node:path";

import {
  buildInputIds,
  DEFAULT_KOKORO_VOICE,
  encodeWavFromFloatPcm,
  isKnownKokoroVoice,
  KOKORO_STYLE_DIMENSION,
  phonemesToTokenIds,
  selectStyleVector,
  SpeechEngineNotReadyError,
  type KokoroSpeechEngine,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
} from "@lune/core";

/**
 * The real Node-backed Kokoro-82M Speech engine (ticket 09): it synthesizes audio
 * in-process via `onnxruntime-node`, loading the model and voice embeddings that
 * Provisioning downloaded into the managed models directory. It implements the Core's
 * `KokoroSpeechEngine` seam, so the Speech Capability depends only on the interface -
 * this native edge lives in the Electron main process, never in @lune/core, keeping
 * the Core pure (developer story 45).
 *
 * Like the Provisioning node gateways this is an intentionally thin edge over
 * environment-dependent effects - text->phoneme conversion (espeak via `phonemizer`)
 * and native ONNX inference - both injected so tests could exercise the engine without
 * shipping weights or a phonemizer. The deterministic transforms it composes
 * (tokenization, style selection, WAV encoding) live in and are tested through the
 * Core's `kokoroSynthesis`. Readiness follows Provisioning: until the Kokoro weights
 * verify, `isReady()` is false and the Speech Capability answers "not ready".
 *
 * Verification note: the two injected edges (phonemization and ONNX inference) are the
 * parts that can only be exercised against the real weights + audio playback, so they
 * carry no unit tests here - the same policy as the Provisioning node gateways.
 */

/** Seam: converts text to a phoneme (IPA) string. Default uses espeak via `phonemizer`. */
export type PhonemizeText = (text: string) => Promise<string>;

/** The tensors one Kokoro forward pass needs. */
export interface KokoroInferenceInputs {
  /** The `[0, ...phonemeTokens, 0]` token sequence. */
  inputIds: number[];
  /** The selected voice style vector (length `KOKORO_STYLE_DIMENSION`). */
  style: Float32Array;
  /** Speaking-rate multiplier (1.0 = natural). */
  speed: number;
}

/** Seam: runs the Kokoro ONNX model, returning 24 kHz mono float PCM in [-1, 1]. */
export type RunKokoroInference = (inputs: KokoroInferenceInputs) => Promise<Float32Array>;

export interface NodeKokoroSpeechEngineOptions {
  /** Absolute path to the provisioned Kokoro ONNX model. */
  modelPath: string;
  /** Absolute path to the directory holding the per-voice `.bin` files. */
  voicesDirectory: string;
  /** Whether the Kokoro weights are provisioned and verified (drives readiness). */
  isReady: () => boolean;
  /** Overridable for tests; defaults to espeak-ng via `phonemizer`. */
  phonemize?: PhonemizeText;
  /** Overridable for tests; defaults to a lazily-created onnxruntime-node session. */
  runInference?: RunKokoroInference;
}

/**
 * Builds the real Kokoro Speech engine. The onnxruntime-node session and the
 * phonemizer are created lazily on first synthesis (and cached) so merely
 * constructing the engine - or importing this module - never loads the native addon.
 */
export function createNodeKokoroSpeechEngine(
  options: NodeKokoroSpeechEngineOptions,
): KokoroSpeechEngine {
  const phonemize = options.phonemize ?? createDefaultPhonemizer();
  const runInference = options.runInference ?? createOnnxRuntimeInference(options.modelPath);
  // Cache each voice's style buffer so repeated synthesis doesn't re-read the file.
  const voiceBufferCache = new Map<string, Float32Array>();

  async function loadVoiceData(voice: string): Promise<Float32Array> {
    const cached = voiceBufferCache.get(voice);
    if (cached !== undefined) {
      return cached;
    }
    const voiceFilePath = path.join(options.voicesDirectory, `${voice}.bin`);
    const fileBytes = await fs.readFile(voiceFilePath);
    // Copy into a fresh, 4-byte-aligned ArrayBuffer so the Float32 view is always valid
    // regardless of the Buffer's underlying byte offset.
    const alignedBuffer = fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength,
    );
    const voiceData = new Float32Array(alignedBuffer);
    voiceBufferCache.set(voice, voiceData);
    return voiceData;
  }

  return {
    isReady: options.isReady,

    async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
      if (!options.isReady()) {
        throw new SpeechEngineNotReadyError();
      }

      // An unknown/absent Voice falls back to Kokoro's flagship, matching the Speech
      // Capability's own contract (defence in depth for a direct engine caller).
      const voice = isKnownKokoroVoice(request.voice) ? request.voice : DEFAULT_KOKORO_VOICE;

      const phonemes = await phonemize(request.text);
      const tokenIds = phonemesToTokenIds(phonemes);
      const voiceData = await loadVoiceData(voice);
      const style = selectStyleVector(voiceData, tokenIds.length);

      const samples = await runInference({
        inputIds: buildInputIds(tokenIds),
        style,
        speed: 1,
      });

      return { audio: encodeWavFromFloatPcm(samples), contentType: "audio/wav" };
    },
  };
}

/** Default Kokoro model path inside the managed models directory (matches the manifest). */
export function defaultKokoroModelPath(modelsDirectoryPath: string): string {
  return path.join(modelsDirectoryPath, "kokoro", "model.onnx");
}

/** Default Kokoro voices directory inside the managed models directory (matches the manifest). */
export function defaultKokoroVoicesDirectory(modelsDirectoryPath: string): string {
  return path.join(modelsDirectoryPath, "kokoro", "voices");
}

/**
 * The default phonemizer: espeak-ng (via the `phonemizer` package) converting text to
 * an IPA phoneme string. Imported lazily so the wasm engine only initializes when
 * synthesis actually runs. `phonemizer` returns one phoneme string per input line;
 * they are joined so the whole utterance tokenizes as one sequence.
 */
function createDefaultPhonemizer(): PhonemizeText {
  return async (text: string): Promise<string> => {
    const { phonemize } = await import("phonemizer");
    const phonemized = await phonemize(text, "en-us");
    return Array.isArray(phonemized) ? phonemized.join(" ") : String(phonemized);
  };
}

/**
 * The default ONNX inference edge: a lazily-created, cached onnxruntime-node session
 * over the provisioned model. Kokoro's inputs are `input_ids` (int64), `style`
 * (float32 [1, 256]), and `speed` (float32 [1]); its single output is the waveform.
 */
function createOnnxRuntimeInference(modelPath: string): RunKokoroInference {
  let sessionPromise: Promise<import("onnxruntime-node").InferenceSession> | undefined;

  return async ({ inputIds, style, speed }: KokoroInferenceInputs): Promise<Float32Array> => {
    const ort = await import("onnxruntime-node");
    if (sessionPromise === undefined) {
      sessionPromise = ort.InferenceSession.create(modelPath);
    }
    const session = await sessionPromise;

    const feeds: Record<string, import("onnxruntime-node").Tensor> = {
      input_ids: new ort.Tensor(
        "int64",
        BigInt64Array.from(inputIds, (id) => BigInt(id)),
        [1, inputIds.length],
      ),
      style: new ort.Tensor("float32", style, [1, KOKORO_STYLE_DIMENSION]),
      speed: new ort.Tensor("float32", Float32Array.from([speed]), [1]),
    };

    const outputs = await session.run(feeds);
    const waveform = outputs[session.outputNames[0]!]!;
    return waveform.data as Float32Array;
  };
}
