import { describe, expect, it } from "vitest";

import {
  ChildRuntimeSupervisor,
  type ChildRuntimeGateway,
  type ChildRuntimeId,
} from "../src/transcription/childRuntimeSupervisor.js";
import {
  createTranscriptionCapability,
  TranscriptionNotReadyError,
} from "../src/transcription/transcriptionCapability.js";

/**
 * Integration test tying the child-Runtime supervisor's health to the Transcription
 * Capability's readiness (ADR-0003, ADR-0006), ported from v1's
 * `transcriptionReadiness.test.ts` with HTTP/statusReporter removed: `isReady` and
 * `transcribe` must both reflect whether the whisper weights are provisioned AND the
 * whisper child Runtime is up and healthy. The process boundary is stubbed.
 */

class FakeChildRuntimeGateway implements ChildRuntimeGateway {
  async start(_runtimeId: ChildRuntimeId): Promise<void> {}
  async stop(_runtimeId: ChildRuntimeId): Promise<void> {}
  async isHealthy(_runtimeId: ChildRuntimeId): Promise<boolean> {
    return true;
  }
}

const WHISPER_ONLY: ReadonlySet<ChildRuntimeId> = new Set<ChildRuntimeId>(["whisper"]);

// Wires the Capability exactly as the Electron main process does: readiness is the
// conjunction of provisioning (weights verified) and the supervisor (child healthy).
function makeCapability(options: {
  supervisor: ChildRuntimeSupervisor;
  whisperProvisioned: boolean;
}) {
  const isRuntimeReady = () =>
    options.whisperProvisioned && options.supervisor.isReady("whisper");
  return createTranscriptionCapability({
    isRuntimeReady,
    transcribe: async () => ({ text: "recognized text" }),
  });
}

describe("local Transcription readiness", () => {
  it("is not ready and throws not-ready until the whisper Runtime is up and provisioned", async () => {
    const supervisor = new ChildRuntimeSupervisor(new FakeChildRuntimeGateway());
    // Provisioned, but the child process hasn't been started yet.
    const capability = makeCapability({ supervisor, whisperProvisioned: true });

    expect(capability.isReady()).toBe(false);
    await expect(capability.transcribe(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      TranscriptionNotReadyError,
    );
  });

  it("is ready and transcribes once the whisper Runtime is reconciled healthy", async () => {
    const supervisor = new ChildRuntimeSupervisor(new FakeChildRuntimeGateway());
    const capability = makeCapability({ supervisor, whisperProvisioned: true });

    // Selecting local Transcription starts the whisper child Runtime.
    await supervisor.reconcile(WHISPER_ONLY);

    expect(capability.isReady()).toBe(true);
    const result = await capability.transcribe(new Uint8Array([1, 2, 3]));
    expect(result.text).toBe("recognized text");
  });

  it("stays not ready when the Runtime is healthy but the weights are not provisioned", async () => {
    const supervisor = new ChildRuntimeSupervisor(new FakeChildRuntimeGateway());
    await supervisor.reconcile(WHISPER_ONLY);
    // Runtime healthy, but weights absent.
    const capability = makeCapability({ supervisor, whisperProvisioned: false });

    expect(capability.isReady()).toBe(false);
    await expect(capability.transcribe(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      TranscriptionNotReadyError,
    );
  });
});
