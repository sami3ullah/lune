import { describe, expect, it } from "vitest";

import { createProvisioningCapability } from "../src/provisioning/provisioningCapability.js";
import type { ProvisionableRuntime } from "../src/provisioning/manifest.js";
import { makeFakeGateways, sha256Hex } from "./provisioningFakes.js";

/**
 * Tests for the Provisioning Capability - the Core public API the Electron main
 * process calls directly. This is the successor of v1's HTTP-driven
 * `provisioningHttp.test.ts` (real server + controller), with HTTP removed: the same
 * flows (start a run to success and watch readiness flip, a clean offline preflight
 * failure, idle status before any run, cancel) are exercised straight against the
 * Capability's methods, with the network/filesystem/disk gateways stubbed.
 */

const MODELS_DIR = "/appsupport/Lune/models";
const KOKORO_URL = "https://models.lune.local/kokoro.onnx";
const KOKORO_BODY = new Uint8Array([5, 6, 7, 8, 9]);
const KOKORO_MANAGED_PATH = `${MODELS_DIR}/kokoro/kokoro.onnx`;

const TEST_MANIFEST: ProvisionableRuntime[] = [
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

function makeCapability(options?: { networkOnline?: boolean }) {
  const fakes = makeFakeGateways();
  fakes.download.setBody(KOKORO_URL, KOKORO_BODY);
  if (options?.networkOnline === false) {
    fakes.network.online = false;
  }
  const capability = createProvisioningCapability({
    gateways: fakes.gateways,
    modelsDirectoryPath: MODELS_DIR,
    manifest: TEST_MANIFEST,
  });
  return { capability, ...fakes };
}

describe("ProvisioningCapability.start", () => {
  it("provisions to success, and readiness flips from not-ready to ready", async () => {
    const { capability, fileSystem } = makeCapability();

    // Before provisioning: Kokoro is not ready.
    await capability.refreshReadiness();
    expect(capability.isRuntimeReady("kokoro")).toBe(false);

    const started = capability.start(["kokoro"]);
    expect(started.phase).toBe("running");

    await capability.awaitCurrentRun();

    const settled = capability.status();
    expect(settled.phase).toBe("succeeded");
    expect(settled.downloadedBytes).toBe(KOKORO_BODY.byteLength);
    expect(settled.totalBytes).toBe(KOKORO_BODY.byteLength);
    // The verified file landed in the managed directory.
    expect(fileSystem.peek(KOKORO_MANAGED_PATH)).toEqual(KOKORO_BODY);
    // After provisioning: readiness reports ready (weights verified).
    expect(capability.isRuntimeReady("kokoro")).toBe(true);
  });

  it("reports the preflight failure and stays not-ready when offline", async () => {
    const { capability, download } = makeCapability({ networkOnline: false });

    capability.start(["kokoro"]);
    await capability.awaitCurrentRun();

    const settled = capability.status();
    expect(settled.phase).toBe("failed");
    expect(settled.preflightFailure?.reason).toBe("network-unavailable");
    // Nothing was fetched, and readiness never flipped on.
    expect(download.calls).toHaveLength(0);
    expect(capability.isRuntimeReady("kokoro")).toBe(false);
  });

  it("is a no-op returning the running status if a run is already in flight", async () => {
    const { capability, download } = makeCapability();

    capability.start(["kokoro"]);
    const secondStart = capability.start(["kokoro"]);
    expect(secondStart.phase).toBe("running");

    await capability.awaitCurrentRun();
    // Only one run happened: the artifact was fetched exactly once.
    expect(download.calls.filter((call) => call.url === KOKORO_URL)).toHaveLength(1);
  });
});

describe("ProvisioningCapability.status", () => {
  it("is idle before any run is started", () => {
    const { capability } = makeCapability();
    expect(capability.status().phase).toBe("idle");
  });
});

describe("ProvisioningCapability.cancel", () => {
  it("is safe to call when idle and leaves the phase idle", () => {
    const { capability } = makeCapability();
    capability.cancel();
    expect(capability.status().phase).toBe("idle");
  });
});
