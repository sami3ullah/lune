import { createSpeechCapability, type RoutingConfig, type SpeechCapability } from "@lune/core";
import {
  createNodeKokoroSpeechEngine,
  defaultKokoroModelPath,
  defaultKokoroVoicesDirectory,
} from "./nodeKokoroSpeechEngine";

/**
 * Wires the Core's Speech Capability to the real in-process Kokoro engine for the
 * Electron main process (ticket 09). The Core owns the seam, the Voice list, and the
 * pure synthesis transforms; this only injects the native edge (onnxruntime-node +
 * espeak) and points it at the Kokoro weights in the one Lune-managed models
 * directory. Readiness is delegated to Provisioning (`isRuntimeReady("kokoro")`), read
 * live, so a not-ready Speech Capability flips to ready the moment the weights verify -
 * with no rebuild (acceptance: ready flips automatically when weights verify).
 */
export interface DesktopSpeechDependencies {
  /** The one Lune-managed models directory Provisioning downloads into. */
  modelsDirectoryPath: string;
  /** The live routing config (which Voice); re-read on every synthesis. */
  getRoutingConfig: () => RoutingConfig;
  /** Whether the Kokoro weights are provisioned and verified (drives readiness). */
  isKokoroReady: () => boolean;
}

/** Builds the Speech Capability over the real in-process Kokoro engine. */
export function createDesktopSpeech(dependencies: DesktopSpeechDependencies): SpeechCapability {
  const engine = createNodeKokoroSpeechEngine({
    modelPath: defaultKokoroModelPath(dependencies.modelsDirectoryPath),
    voicesDirectory: defaultKokoroVoicesDirectory(dependencies.modelsDirectoryPath),
    isReady: dependencies.isKokoroReady,
  });
  return createSpeechCapability({
    getRoutingConfig: dependencies.getRoutingConfig,
    engine,
  });
}

/**
 * The env-gated dev trigger (`LUNE_SPEAK_ON_START`): when set and Kokoro is ready, it
 * synthesizes a short phrase in the main process and logs the resulting WAV size. This
 * is how ticket 09's "native addons (onnxruntime-node, espeak wasm) load inside
 * Electron main in dev" acceptance is exercised before the voice loop exists (ticket
 * 11) - producing audio bytes proves both native edges loaded and ran. A no-op when the
 * env var is absent or Kokoro isn't provisioned yet, so it is safe to call at boot.
 *
 * @returns whether synthesis actually ran.
 */
export async function runSpeechDevTrigger(
  speech: SpeechCapability,
  log: (message: string) => void = (message) => console.log(`[lune] ${message}`),
): Promise<boolean> {
  if (process.env.LUNE_SPEAK_ON_START === undefined || process.env.LUNE_SPEAK_ON_START.length === 0) {
    return false;
  }
  if (!speech.isReady()) {
    log("speech dev trigger: Kokoro is not provisioned yet, skipping");
    return false;
  }

  log("speech dev trigger: synthesizing a test phrase (loading onnxruntime-node + espeak)");
  const result = await speech.synthesize("Lune's voice is ready.");
  log(`speech dev trigger: synthesized ${result.audio.byteLength} bytes of ${result.contentType}`);
  return true;
}
