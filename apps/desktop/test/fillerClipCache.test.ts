import { describe, expect, it } from "vitest";
import type { SpeechCapability } from "@lune/core";
import { createFillerClipCache, FILLER_PHRASES } from "../src/main/speech/fillerClipCache";

// The instant-acknowledgement cache: pre-synthesized filler clips a voice turn plays the
// moment it starts, so Lune answers back immediately while the real answer is produced.

/** A fake Speech Capability that "synthesizes" each phrase to recognizable bytes. */
function fakeSpeech(options: { ready?: boolean } = {}): SpeechCapability & { synthesized: string[] } {
  const synthesized: string[] = [];
  return {
    synthesized,
    isReady: () => options.ready ?? true,
    synthesize: async (text: string) => {
      synthesized.push(text);
      return { audio: new TextEncoder().encode(text), contentType: "audio/wav" };
    },
  };
}

const decodeBase64 = (base64: string): string => Buffer.from(base64, "base64").toString();

/** Waits for the cache's async priming to settle (each synthesize resolves on a microtask). */
async function settle(): Promise<void> {
  for (let i = 0; i < FILLER_PHRASES.length + 2; i += 1) {
    await Promise.resolve();
  }
}

describe("createFillerClipCache", () => {
  it("returns nothing before priming completes, then serves cached clips", async () => {
    const speech = fakeSpeech();
    const cache = createFillerClipCache({
      speech,
      getVoiceId: () => "af_heart",
      encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
      phrases: ["okay, one sec.", "hmm, let me see."],
      pickIndex: () => 0,
    });

    expect(cache.takeClip()).toBeNull();
    cache.prime();
    expect(cache.takeClip()).toBeNull();

    await settle();
    const clip = cache.takeClip();
    expect(clip).not.toBeNull();
    expect(decodeBase64(clip!.audioBase64)).toBe("okay, one sec.");
    expect(clip!.contentType).toBe("audio/wav");
  });

  it("does not prime while speech is not ready", async () => {
    const speech = fakeSpeech({ ready: false });
    const cache = createFillerClipCache({
      speech,
      getVoiceId: () => "af_heart",
      encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
    });

    cache.prime();
    await settle();
    expect(speech.synthesized).toEqual([]);
    expect(cache.takeClip()).toBeNull();
  });

  it("primes each phrase exactly once even when prime is called repeatedly", async () => {
    const speech = fakeSpeech();
    const cache = createFillerClipCache({
      speech,
      getVoiceId: () => "af_heart",
      encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
      phrases: ["okay, one sec."],
    });

    cache.prime();
    cache.prime();
    await settle();
    cache.prime();
    await settle();
    expect(speech.synthesized).toEqual(["okay, one sec."]);
  });

  it("never serves the same clip twice in a row", async () => {
    const speech = fakeSpeech();
    let pick = 1;
    const cache = createFillerClipCache({
      speech,
      getVoiceId: () => "af_heart",
      encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
      phrases: ["first.", "second.", "third."],
      pickIndex: () => pick,
    });
    cache.prime();
    await settle();

    expect(decodeBase64(cache.takeClip()!.audioBase64)).toBe("second.");
    // The picker asks for the same clip again; the cache steps past it.
    expect(decodeBase64(cache.takeClip()!.audioBase64)).toBe("third.");
    pick = 0;
    expect(decodeBase64(cache.takeClip()!.audioBase64)).toBe("first.");
  });

  it("invalidates and re-primes when the Voice changes", async () => {
    const speech = fakeSpeech();
    let voice = "af_heart";
    const cache = createFillerClipCache({
      speech,
      getVoiceId: () => voice,
      encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
      phrases: ["okay, one sec."],
    });
    cache.prime();
    await settle();
    expect(cache.takeClip()).not.toBeNull();

    voice = "am_michael";
    // The old voice's clips are dropped (this turn gets no filler) and re-priming starts.
    expect(cache.takeClip()).toBeNull();
    await settle();
    expect(cache.takeClip()).not.toBeNull();
    expect(speech.synthesized).toEqual(["okay, one sec.", "okay, one sec."]);
  });

  it("degrades quietly when priming fails", async () => {
    const errors: unknown[] = [];
    const speech: SpeechCapability = {
      isReady: () => true,
      synthesize: async () => {
        throw new Error("weights vanished");
      },
    };
    const cache = createFillerClipCache({
      speech,
      getVoiceId: () => "af_heart",
      encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
      phrases: ["okay, one sec."],
      onError: (error) => errors.push(error),
    });

    cache.prime();
    await settle();
    expect(cache.takeClip()).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
