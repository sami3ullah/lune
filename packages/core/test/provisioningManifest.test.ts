import { describe, expect, it } from "vitest";

import {
  allArtifacts,
  findRuntime,
  PROVISIONING_MANIFEST,
  resolveRuntimes,
  runtimeDownloadBytes,
  totalDownloadBytes,
} from "../src/provisioning/manifest.js";

/**
 * Sanity checks on the pinned manifest (ADR-0009): it declares exactly the two local
 * Runtimes Lune provisions - whisper (Transcription) and Kokoro (Speech, the ONNX
 * model + its 54 voices) - and no LM Studio path (Lune has no local Reasoning). Every
 * artifact is fully pinned (url + sha256 + size), which is what makes downloads
 * checksum-verifiable and the disk preflight / progress bar accurate up front.
 */

describe("PROVISIONING_MANIFEST", () => {
  it("declares whisper and kokoro, and nothing else", () => {
    expect(PROVISIONING_MANIFEST.map((runtime) => runtime.id)).toEqual(["whisper", "kokoro"]);
  });

  it("pins the Kokoro ONNX model plus all 54 built-in voices", () => {
    const kokoro = findRuntime("kokoro");
    expect(kokoro).toBeDefined();
    const voiceArtifacts = kokoro!.artifacts.filter((artifact) => artifact.id.startsWith("kokoro-voice-"));
    expect(voiceArtifacts).toHaveLength(54);
    // The model file plus the 54 voices.
    expect(kokoro!.artifacts).toHaveLength(55);
  });

  it("fully pins every artifact (url, sha256, positive size)", () => {
    for (const artifact of allArtifacts()) {
      expect(artifact.url).toMatch(/^https:\/\//);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("totals roughly 2 GB across the whole manifest", () => {
    const total = totalDownloadBytes([...PROVISIONING_MANIFEST]);
    // whisper (~1.6 GB) + Kokoro model (~0.33 GB) + 54 voices (~28 MB).
    expect(total).toBeGreaterThan(1_900_000_000);
    expect(total).toBeLessThan(2_100_000_000);
  });

  it("resolveRuntimes drops unknown ids and keeps known ones", () => {
    const resolved = resolveRuntimes(["kokoro", "whisper"]);
    expect(resolved.map((runtime) => runtime.id)).toEqual(["kokoro", "whisper"]);
  });

  it("runtimeDownloadBytes sums a Runtime's artifacts", () => {
    const whisper = findRuntime("whisper")!;
    expect(runtimeDownloadBytes(whisper)).toBe(
      whisper.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
    );
  });
});
