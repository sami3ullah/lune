import { describe, expect, it } from "vitest";

import { createSpeechCapability } from "../src/speech/speechCapability.js";
import {
  createDeferredKokoroSpeechEngine,
  SpeechEngineNotReadyError,
  type KokoroSpeechEngine,
  type SpeechSynthesisRequest,
} from "../src/speech/speechEngine.js";
import { DEFAULT_KOKORO_VOICE } from "../src/speech/kokoroVoices.js";
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "../src/reasoning/routingConfig.js";

/**
 * Tests for the Speech Capability - the Core public API the Electron main process
 * calls to synthesize each sentence. The engine seam (the in-process ONNX call) is
 * stubbed with a fake engine, exactly as the spec's test strategy prescribes, so
 * synthesis behaviour is exercised without shipping model weights. Successor of v1's
 * `localSpeech` Endpoint Contract suite, with HTTP removed.
 */

const CANNED_KOKORO_WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x11]); // "RIFF.."

/** A stub Kokoro engine that is ready and records what it was asked to synthesize. */
function makeReadyStubEngine(): { engine: KokoroSpeechEngine; calls: SpeechSynthesisRequest[] } {
  const calls: SpeechSynthesisRequest[] = [];
  const engine: KokoroSpeechEngine = {
    isReady: () => true,
    synthesize: async (request) => {
      calls.push(request);
      return { audio: CANNED_KOKORO_WAV, contentType: "audio/wav" };
    },
  };
  return { engine, calls };
}

/** A routing config selecting a specific (known) Voice for Speech. */
function configWithVoice(voice: string): RoutingConfig {
  return { ...DEFAULT_ROUTING_CONFIG, speech: { voice } };
}

describe("SpeechCapability.synthesize when ready", () => {
  it("synthesizes on-device and returns audio, honoring the selected Voice", async () => {
    const { engine, calls } = makeReadyStubEngine();
    const capability = createSpeechCapability({
      getRoutingConfig: () => configWithVoice("am_michael"),
      engine,
    });

    const result = await capability.synthesize("Hello from Kokoro");

    expect(result.contentType).toBe("audio/wav");
    expect(result.audio).toBe(CANNED_KOKORO_WAV);
    expect(calls).toEqual([{ text: "Hello from Kokoro", voice: "am_michael" }]);
  });

  it("falls back to the default Voice when the configured Voice is unknown", async () => {
    const { engine, calls } = makeReadyStubEngine();
    const capability = createSpeechCapability({
      getRoutingConfig: () => configWithVoice("not_a_real_voice"),
      engine,
    });

    await capability.synthesize("hi");

    expect(calls[0]!.voice).toBe(DEFAULT_KOKORO_VOICE);
  });

  it("trims the text and rejects an empty chunk without synthesizing", async () => {
    const { engine, calls } = makeReadyStubEngine();
    const capability = createSpeechCapability({
      getRoutingConfig: () => DEFAULT_ROUTING_CONFIG,
      engine,
    });

    await expect(capability.synthesize("   ")).rejects.toThrow(/no text/i);
    expect(calls).toHaveLength(0);
  });
});

describe("SpeechCapability when the Runtime is not ready", () => {
  it("reports not ready and throws without attempting synthesis (deferred engine)", async () => {
    const capability = createSpeechCapability({
      getRoutingConfig: () => DEFAULT_ROUTING_CONFIG,
      engine: createDeferredKokoroSpeechEngine(),
    });

    expect(capability.isReady()).toBe(false);
    await expect(capability.synthesize("hello")).rejects.toBeInstanceOf(SpeechEngineNotReadyError);
  });

  it("flips to ready and synthesizes once the weights verify (readiness follows Provisioning)", async () => {
    // A stub engine whose readiness is driven by a mutable flag - standing in for the
    // real engine reading Provisioning's per-Runtime readiness.
    let weightsVerified = false;
    const engine: KokoroSpeechEngine = {
      isReady: () => weightsVerified,
      synthesize: async () =>
        weightsVerified
          ? { audio: CANNED_KOKORO_WAV, contentType: "audio/wav" }
          : Promise.reject(new SpeechEngineNotReadyError()),
    };
    const capability = createSpeechCapability({
      getRoutingConfig: () => DEFAULT_ROUTING_CONFIG,
      engine,
    });

    expect(capability.isReady()).toBe(false);

    // Provisioning finishes verifying the Kokoro weights.
    weightsVerified = true;

    expect(capability.isReady()).toBe(true);
    const result = await capability.synthesize("now ready");
    expect(result.audio).toBe(CANNED_KOKORO_WAV);
  });
});
