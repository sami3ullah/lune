import { describe, expect, it } from "vitest";

import {
  buildInputIds,
  encodeWavFromFloatPcm,
  KOKORO_MAX_TOKENS,
  KOKORO_STYLE_DIMENSION,
  KOKORO_TOKEN_VOCAB,
  phonemesToTokenIds,
  selectStyleVector,
} from "../src/speech/kokoroSynthesis.js";

/**
 * Unit tests for the deterministic Kokoro synthesis transforms - the parts that can
 * be exercised without the model or a phonemizer: vocab tokenization, input framing,
 * voice style-vector selection, and WAV encoding. The onnxruntime-node inference and
 * espeak phonemization above these are the untested thin edge in the Shell. Carried
 * verbatim from v1's `kokoroSynthesis` suite.
 */

describe("phonemesToTokenIds", () => {
  it("maps known phoneme characters to their canonical vocab ids", () => {
    // Characters drawn straight from the model's tokenizer vocab.
    expect(phonemesToTokenIds("hɛɫo")).toEqual([
      KOKORO_TOKEN_VOCAB["h"],
      KOKORO_TOKEN_VOCAB["ɛ"],
      // "ɫ" is not in the vocab, so it is dropped.
      KOKORO_TOKEN_VOCAB["o"],
    ]);
  });

  it("drops characters that are not in the vocabulary", () => {
    // "€" and "3" are not phoneme tokens; only the space (id 16) survives.
    expect(phonemesToTokenIds("€ 3")).toEqual([KOKORO_TOKEN_VOCAB[" "]]);
  });

  it("truncates to the maximum token count so a style row always exists", () => {
    const longPhonemes = "a".repeat(KOKORO_MAX_TOKENS + 50);
    expect(phonemesToTokenIds(longPhonemes)).toHaveLength(KOKORO_MAX_TOKENS);
  });
});

describe("buildInputIds", () => {
  it("wraps the tokens with the pad/boundary token 0 at both ends", () => {
    expect(buildInputIds([44, 45])).toEqual([0, 44, 45, 0]);
  });
});

describe("selectStyleVector", () => {
  // A synthetic voice buffer where row R is filled with the value R, so the selected
  // row is unambiguous.
  function makeVoiceBuffer(rowCount: number): Float32Array {
    const data = new Float32Array(rowCount * KOKORO_STYLE_DIMENSION);
    for (let row = 0; row < rowCount; row += 1) {
      data.fill(row, row * KOKORO_STYLE_DIMENSION, (row + 1) * KOKORO_STYLE_DIMENSION);
    }
    return data;
  }

  it("selects the row matching the phoneme-token count", () => {
    const voiceData = makeVoiceBuffer(KOKORO_MAX_TOKENS);
    const style = selectStyleVector(voiceData, 3);
    expect(style).toHaveLength(KOKORO_STYLE_DIMENSION);
    expect([...new Set(style)]).toEqual([3]);
  });

  it("clamps to the last available row when the token count exceeds the buffer", () => {
    const voiceData = makeVoiceBuffer(KOKORO_MAX_TOKENS);
    const style = selectStyleVector(voiceData, KOKORO_MAX_TOKENS + 100);
    expect([...new Set(style)]).toEqual([KOKORO_MAX_TOKENS - 1]);
  });

  it("throws when the voice buffer is too small for the requested row", () => {
    const tinyVoiceData = new Float32Array(KOKORO_STYLE_DIMENSION); // only row 0
    expect(() => selectStyleVector(tinyVoiceData, 5)).toThrow();
  });
});

describe("encodeWavFromFloatPcm", () => {
  it("produces a valid 16-bit PCM WAV header for the given sample rate", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWavFromFloatPcm(samples, 24_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    // "RIFF"...."WAVE" container with a 44-byte header + 2 bytes/sample of data.
    expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe("RIFF");
    expect(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + samples.length * 2);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("clamps out-of-range samples and scales to signed 16-bit", () => {
    const wav = encodeWavFromFloatPcm(new Float32Array([2, -2, 0]), 24_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getInt16(44, true)).toBe(32767); // +2 clamps to +1 -> max
    expect(view.getInt16(46, true)).toBe(-32767); // -2 clamps to -1 -> -max
    expect(view.getInt16(48, true)).toBe(0);
  });
});
