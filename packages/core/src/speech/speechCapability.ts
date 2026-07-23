/**
 * The Core's Speech Capability - the public entry point for synthesizing one chunk
 * of answer text (typically one sentence) into playable audio with Kokoro, gated on
 * the Kokoro Runtime's weights being provisioned and verified.
 *
 * This is the successor of v1's config-driven local Speech Provider, with HTTP
 * removed: the Capability reads the selected Voice from the live routing config,
 * gates on Kokoro readiness (throwing {@link SpeechEngineNotReadyError} before any
 * synthesis when the weights aren't ready), and returns the WAV bytes the Shell
 * plays. The Core owns no transport and no model - the Electron main process injects
 * the real onnxruntime-node engine (its readiness driven by the Provisioning
 * Capability); a test injects a stub or the deferred engine.
 *
 * The Shell sentence-streams: it feeds each completed sentence here as the Reasoning
 * stream produces it, so the first sentence synthesizes and plays while later ones
 * are still being generated.
 */
import { DEFAULT_KOKORO_VOICE, isKnownKokoroVoice } from "./kokoroVoices.js";
import {
  SpeechEngineNotReadyError,
  type KokoroSpeechEngine,
  type SpeechSynthesisResult,
} from "./speechEngine.js";
import type { RoutingConfig } from "../reasoning/routingConfig.js";

/** The injected boundaries the Speech Capability is built from. */
export interface SpeechCapabilityDependencies {
  /** The live routing config (which Voice); re-read on every synthesis. */
  getRoutingConfig: () => RoutingConfig;
  /**
   * The Kokoro Speech engine seam. Production is the in-process onnxruntime-node
   * engine (in the Electron main process) whose readiness follows Provisioning; tests
   * inject a stub or the deferred engine.
   */
  engine: KokoroSpeechEngine;
}

/** The Core's Speech Capability: readiness plus one synthesis entry point. */
export interface SpeechCapability {
  /**
   * Whether Speech can synthesize right now (the Kokoro weights are provisioned and
   * verified). The Shell checks this before speaking so a not-ready state surfaces as
   * silent-but-explained rather than a hang.
   */
  isReady(): boolean;
  /**
   * Synthesizes one chunk of text into audio in the configured Voice. An absent or
   * unknown Voice falls back to Kokoro's flagship {@link DEFAULT_KOKORO_VOICE} rather
   * than failing. Throws {@link SpeechEngineNotReadyError} (before any synthesis) when
   * the Runtime isn't ready, and throws for empty text - the caller only ever passes a
   * completed, non-empty sentence.
   */
  synthesize(text: string): Promise<SpeechSynthesisResult>;
}

export function createSpeechCapability(
  dependencies: SpeechCapabilityDependencies,
): SpeechCapability {
  const { getRoutingConfig, engine } = dependencies;

  /** Falls back to Kokoro's default Voice when the configured Voice is absent/unknown. */
  function resolveVoice(): string {
    const selectedVoice = getRoutingConfig().speech.voice;
    return isKnownKokoroVoice(selectedVoice) ? selectedVoice : DEFAULT_KOKORO_VOICE;
  }

  return {
    isReady: () => engine.isReady(),

    async synthesize(text: string): Promise<SpeechSynthesisResult> {
      if (!engine.isReady()) {
        // Readiness-gating: no verified weights -> not ready -> throw before synthesis.
        throw new SpeechEngineNotReadyError();
      }

      const trimmedText = text.trim();
      if (trimmedText.length === 0) {
        throw new Error("No text to synthesize");
      }

      return engine.synthesize({ text: trimmedText, voice: resolveVoice() });
    },
  };
}
