/**
 * Pure, deterministic pieces of the Kokoro-82M synthesis pipeline: the phoneme-token
 * vocabulary, phoneme->token-id mapping, voice style-vector selection, and
 * float-PCM -> WAV encoding.
 *
 * These are separated from the onnxruntime-node edge (the Shell's
 * `nodeKokoroSpeechEngine`) precisely because they are testable without shipping the
 * multi-gigabyte model or running native inference: given phonemes and a voice buffer
 * they produce exact, assertable outputs. The model load, phonemization, and
 * inference themselves are the thin, environment-dependent edge the Electron main
 * process supplies. Carried verbatim from v1's `kokoroSynthesis.ts` (ADR-0004).
 */

/**
 * Kokoro's phoneme-token vocabulary, taken verbatim from the model's own
 * `tokenizer.json` (`onnx-community/Kokoro-82M-v1.0-ONNX`). Each phoneme character
 * maps to the integer id the model was trained on; transcribing this by hand would
 * risk silent mis-synthesis, so it is copied exactly from the canonical source.
 */
export const KOKORO_TOKEN_VOCAB: Readonly<Record<string, number>> = {
  $: 0, ";": 1, ":": 2, ",": 3, ".": 4, "!": 5, "?": 6, "—": 9, "…": 10, '"': 11,
  "(": 12, ")": 13, "“": 14, "”": 15, " ": 16, "̃": 17, ʣ: 18, ʥ: 19, ʦ: 20, ʨ: 21,
  ᵝ: 22, ꭧ: 23, A: 24, I: 25, O: 31, Q: 33, S: 35, T: 36, W: 39, Y: 41, ᵊ: 42,
  a: 43, b: 44, c: 45, d: 46, e: 47, f: 48, h: 50, i: 51, j: 52, k: 53, l: 54,
  m: 55, n: 56, o: 57, p: 58, q: 59, r: 60, s: 61, t: 62, u: 63, v: 64, w: 65,
  x: 66, y: 67, z: 68, ɑ: 69, ɐ: 70, ɒ: 71, æ: 72, β: 75, ɔ: 76, ɕ: 77, ç: 78,
  ɖ: 80, ð: 81, ʤ: 82, ə: 83, ɚ: 85, ɛ: 86, ɜ: 87, ɟ: 90, ɡ: 92, ɥ: 99, ɨ: 101,
  ɪ: 102, ʝ: 103, ɯ: 110, ɰ: 111, ŋ: 112, ɳ: 113, ɲ: 114, ɴ: 115, ø: 116, ɸ: 118,
  θ: 119, œ: 120, ɹ: 123, ɾ: 125, ɻ: 126, ʁ: 128, ɽ: 129, ʂ: 130, ʃ: 131, ʈ: 132,
  ʧ: 133, ʊ: 135, ʋ: 136, ʌ: 138, ɣ: 139, ɤ: 140, χ: 142, ʎ: 143, ʒ: 147, ʔ: 148,
  ˈ: 156, ˌ: 157, ː: 158, ʰ: 162, ʲ: 164, "↓": 169, "→": 171, "↗": 172, "↘": 173, ᵻ: 177,
};

/**
 * The number of style-embedding rows a Kokoro voice file holds (indices 0..509).
 * The style vector is chosen by phoneme-token count, so the token sequence is
 * clamped to this many tokens.
 */
export const KOKORO_MAX_TOKENS = 510;

/** Width of a single Kokoro style vector (the model's `style` input dimension). */
export const KOKORO_STYLE_DIMENSION = 256;

/** Kokoro synthesizes 24 kHz mono audio. */
export const KOKORO_SAMPLE_RATE_HZ = 24_000;

/**
 * Maps a phoneme string to the model's token ids, dropping any character not in the
 * vocabulary (espeak occasionally emits symbols Kokoro doesn't tokenize). The result
 * is truncated to `KOKORO_MAX_TOKENS` so it always indexes a valid style row.
 */
export function phonemesToTokenIds(phonemes: string): number[] {
  const tokenIds: number[] = [];
  for (const character of phonemes) {
    const tokenId = KOKORO_TOKEN_VOCAB[character];
    if (tokenId !== undefined) {
      tokenIds.push(tokenId);
    }
    if (tokenIds.length >= KOKORO_MAX_TOKENS) {
      break;
    }
  }
  return tokenIds;
}

/**
 * Wraps the phoneme token ids with the model's begin/end pad token (id 0), the exact
 * `[0, ...tokens, 0]` sequence Kokoro expects as `input_ids`.
 */
export function buildInputIds(tokenIds: readonly number[]): number[] {
  return [0, ...tokenIds, 0];
}

/**
 * Selects the voice's style vector for a given phoneme-token count. A Kokoro voice
 * file is a flat Float32 buffer of `KOKORO_MAX_TOKENS` rows x `KOKORO_STYLE_DIMENSION`
 * columns; the row chosen is the one matching the (clamped) token count, which is how
 * Kokoro conditions prosody on utterance length.
 */
export function selectStyleVector(voiceData: Float32Array, tokenCount: number): Float32Array {
  const rowIndex = Math.max(0, Math.min(tokenCount, KOKORO_MAX_TOKENS - 1));
  const start = rowIndex * KOKORO_STYLE_DIMENSION;
  const end = start + KOKORO_STYLE_DIMENSION;
  if (end > voiceData.length) {
    throw new Error(
      `Kokoro voice data too small for style row ${rowIndex}: have ${voiceData.length} floats, need ${end}`,
    );
  }
  // Copy so the returned vector is independent of the (cached) source buffer.
  return voiceData.slice(start, end);
}

/**
 * Encodes 32-bit float PCM samples (range [-1, 1], mono) as a 16-bit PCM WAV file.
 * The Shell plays the returned bytes as `audio/wav`, matching the cloud path's audio
 * so one player needs no per-Vendor branching.
 */
export function encodeWavFromFloatPcm(
  samples: Float32Array,
  sampleRateHz: number = KOKORO_SAMPLE_RATE_HZ,
): Uint8Array {
  const bytesPerSample = 2; // 16-bit
  const channelCount = 1; // mono
  const dataByteLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  // RIFF header
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, "WAVE");
  // fmt chunk
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * channelCount * bytesPerSample, true); // byte rate
  view.setUint16(32, channelCount * bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  // data chunk
  writeAscii(36, "data");
  view.setUint32(40, dataByteLength, true);

  // Clamp each float to [-1, 1] and scale to signed 16-bit.
  let writeOffset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(writeOffset, Math.round(clamped * 32767), true);
    writeOffset += bytesPerSample;
  }

  return new Uint8Array(buffer);
}
