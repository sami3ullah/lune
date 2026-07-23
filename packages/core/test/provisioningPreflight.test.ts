import { describe, expect, it } from "vitest";

import { runPreflight } from "../src/provisioning/preflight.js";
import type { ProvisionableRuntime } from "../src/provisioning/manifest.js";
import { FakeDiskSpaceProbe, FakeNetworkProbe } from "./provisioningFakes.js";

/**
 * Seam-3 tests for the preflight (ADR-0009): network / disk gating before any
 * download, with all probes stubbed. Ported from v1, minus the LM Studio-install
 * cases (Lune has no local Reasoning).
 */

const KOKORO_RUNTIME: ProvisionableRuntime = {
  id: "kokoro",
  displayName: "Speech",
  artifacts: [
    {
      id: "kokoro-82m-onnx",
      displayName: "Kokoro",
      relativePath: "kokoro/kokoro.onnx",
      url: "https://models.lune.local/kokoro.onnx",
      sha256: "def",
      sizeBytes: 330_000_000,
      version: "1.0",
    },
  ],
};

describe("runPreflight", () => {
  it("fails clearly when the network is unavailable, without touching disk", async () => {
    const result = await runPreflight({
      runtimes: [KOKORO_RUNTIME],
      modelsDirectoryPath: "/models",
      diskSpace: new FakeDiskSpaceProbe(1_000_000_000_000),
      network: new FakeNetworkProbe(false),
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("network-unavailable");
  });

  it("fails clearly when free disk is below the download size plus margin", async () => {
    const result = await runPreflight({
      runtimes: [KOKORO_RUNTIME], // 330MB + 2GB margin required
      modelsDirectoryPath: "/models",
      diskSpace: new FakeDiskSpaceProbe(1_000_000_000), // only 1GB free
      network: new FakeNetworkProbe(true),
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("insufficient-disk");
    expect(result.failure?.requiredBytes).toBeGreaterThan(result.failure!.availableBytes!);
  });

  it("passes when the network is up and there is ample free disk", async () => {
    const result = await runPreflight({
      runtimes: [KOKORO_RUNTIME],
      modelsDirectoryPath: "/models",
      diskSpace: new FakeDiskSpaceProbe(1_000_000_000_000),
      network: new FakeNetworkProbe(true),
    });

    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  });
});
