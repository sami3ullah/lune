import { describe, expect, it } from "vitest";

import { ProvisioningOrchestrator } from "../src/provisioning/orchestrator.js";
import type { ProvisionableRuntime } from "../src/provisioning/manifest.js";
import { makeFakeGateways, sha256Hex } from "./provisioningFakes.js";

/**
 * Seam-3 tests for the orchestrator (ADR-0009): idempotent per-Runtime recovery,
 * failure isolation across Runtimes, and the ready/not-ready signal - all with the
 * network/filesystem/disk layers stubbed. Ported from v1, with the two Runtimes now
 * both file-artifact Runtimes (Lune has no LM Studio-managed model path).
 */

const MODELS_DIR = "/appsupport/Lune/models";

const WHISPER_URL = "https://models.lune.local/whisper.bin";
const WHISPER_BODY = new Uint8Array([1, 2, 3, 4]);
const KOKORO_URL = "https://models.lune.local/kokoro.onnx";
const KOKORO_BODY = new Uint8Array([5, 6, 7, 8, 9]);

const TEST_MANIFEST: ProvisionableRuntime[] = [
  {
    id: "whisper",
    displayName: "Transcription",
    artifacts: [
      {
        id: "whisper-large-v3-turbo",
        displayName: "whisper",
        relativePath: "whisper/ggml.bin",
        url: WHISPER_URL,
        sha256: sha256Hex(WHISPER_BODY),
        sizeBytes: WHISPER_BODY.byteLength,
        version: "1.0",
      },
    ],
  },
  {
    id: "kokoro",
    displayName: "Speech",
    artifacts: [
      {
        id: "kokoro-82m-onnx",
        displayName: "Kokoro",
        relativePath: "kokoro/kokoro.onnx",
        url: KOKORO_URL,
        sha256: sha256Hex(KOKORO_BODY),
        sizeBytes: KOKORO_BODY.byteLength,
        version: "1.0",
      },
    ],
  },
];

function makeOrchestrator(overrides?: Parameters<typeof makeFakeGateways>[0]) {
  const fakes = makeFakeGateways(overrides);
  fakes.download.setBody(WHISPER_URL, WHISPER_BODY);
  fakes.download.setBody(KOKORO_URL, KOKORO_BODY);
  const orchestrator = new ProvisioningOrchestrator({
    gateways: fakes.gateways,
    modelsDirectoryPath: MODELS_DIR,
    manifest: TEST_MANIFEST,
  });
  return { orchestrator, ...fakes };
}

describe("ProvisioningOrchestrator.provision", () => {
  it("provisions selected Runtimes into the managed directory and reports ready", async () => {
    const { orchestrator, fileSystem } = makeOrchestrator();

    const result = await orchestrator.provision(["kokoro"]);

    expect(result.ok).toBe(true);
    expect(result.runtimes).toHaveLength(1);
    expect(result.runtimes[0]).toMatchObject({ runtimeId: "kokoro", ready: true });
    expect(fileSystem.peek(`${MODELS_DIR}/kokoro/kokoro.onnx`)).toEqual(KOKORO_BODY);
  });

  it("stops before downloading and reports the preflight failure when offline", async () => {
    const { orchestrator, network, download } = makeOrchestrator();
    network.online = false;

    const result = await orchestrator.provision(["kokoro"]);

    expect(result.ok).toBe(false);
    expect(result.preflight.failure?.reason).toBe("network-unavailable");
    expect(result.runtimes).toHaveLength(0);
    expect(download.calls).toHaveLength(0);
  });

  it("is idempotent - re-running re-downloads nothing already verified", async () => {
    const { orchestrator, download } = makeOrchestrator();

    await orchestrator.provision(["kokoro"]);
    const callsAfterFirstRun = download.calls.length;
    expect(callsAfterFirstRun).toBeGreaterThan(0);

    await orchestrator.provision(["kokoro"]);
    // Second run finds the verified file and skips the network entirely.
    expect(download.calls.length).toBe(callsAfterFirstRun);
  });

  it("isolates a failure to one Runtime and retries only the failed one on re-run", async () => {
    // First run: Kokoro's body is missing from the server, so only it fails; whisper
    // still provisions.
    const fakes = makeFakeGateways();
    fakes.download.setBody(WHISPER_URL, WHISPER_BODY);
    // Note: kokoro body intentionally NOT set yet -> its download throws.
    const orchestrator = new ProvisioningOrchestrator({
      gateways: fakes.gateways,
      modelsDirectoryPath: MODELS_DIR,
      manifest: TEST_MANIFEST,
    });

    const firstRun = await orchestrator.provision(["whisper", "kokoro"]);
    expect(firstRun.ok).toBe(false);
    expect(firstRun.runtimes.find((r) => r.runtimeId === "whisper")?.ready).toBe(true);
    expect(firstRun.runtimes.find((r) => r.runtimeId === "kokoro")?.ready).toBe(false);

    const whisperDownloadCallsAfterFirstRun = fakes.download.calls.filter((c) => c.url === WHISPER_URL).length;

    // Fix the server, re-run: whisper is already verified (skipped), only Kokoro retries.
    fakes.download.setBody(KOKORO_URL, KOKORO_BODY);
    const secondRun = await orchestrator.provision(["whisper", "kokoro"]);

    expect(secondRun.ok).toBe(true);
    // No new whisper download on the second run - it is already verified on disk.
    expect(fakes.download.calls.filter((c) => c.url === WHISPER_URL).length).toBe(whisperDownloadCallsAfterFirstRun);
  });

  it("forwards per-artifact progress tagged with the Runtime", async () => {
    const { orchestrator } = makeOrchestrator();
    const progressRuntimeIds = new Set<string>();

    await orchestrator.provision(["kokoro"], {
      onProgress: (progress) => progressRuntimeIds.add(progress.runtimeId),
    });

    expect([...progressRuntimeIds]).toEqual(["kokoro"]);
  });

  it("reports full progress for an already-present artifact so a re-run reaches 100%", async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.provision(["kokoro"]);

    // Second run: nothing downloads, but progress must still account for the bytes.
    let lastDownloadedBytes = 0;
    await orchestrator.provision(["kokoro"], {
      onProgress: (progress) => {
        lastDownloadedBytes = progress.downloadedBytes;
      },
    });

    expect(lastDownloadedBytes).toBe(KOKORO_BODY.byteLength);
  });
});

describe("ProvisioningOrchestrator.isRuntimeProvisioned", () => {
  it("is false before provisioning and true after (not ready until weights verify)", async () => {
    const { orchestrator } = makeOrchestrator();

    expect(await orchestrator.isRuntimeProvisioned("kokoro")).toBe(false);

    await orchestrator.provision(["kokoro"]);

    expect(await orchestrator.isRuntimeProvisioned("kokoro")).toBe(true);
  });

  it("is false when the on-disk file is corrupt (fails verification)", async () => {
    const { orchestrator, fileSystem } = makeOrchestrator();
    // A wrong-bytes file sitting at the managed path must not read as provisioned.
    fileSystem.seedFile(`${MODELS_DIR}/kokoro/kokoro.onnx`, new Uint8Array([0, 0, 0]));

    expect(await orchestrator.isRuntimeProvisioned("kokoro")).toBe(false);
  });
});
