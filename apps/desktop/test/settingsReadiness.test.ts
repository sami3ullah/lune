import { describe, expect, it } from "vitest";

import { deriveReadinessRows, type ReadinessInput } from "../src/main/settings/readiness";

/**
 * Unit tests for the Settings readiness derivation (ticket 13). The rows must mirror
 * the Core status: Reasoning is gated on the routed Vendor's key ("no key" when
 * absent), and the local Capabilities surface the shared Provisioning run's live
 * progress ("Downloading NN%") or an explained not-ready state - never a silent hang.
 */

const IDLE_PROVISIONING: ReadinessInput["provisioning"] = {
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: 0,
  preflightFailure: undefined,
};

function baseInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    reasoning: { vendorDisplayName: "Google Gemini", keyed: true },
    provisioning: IDLE_PROVISIONING,
    whisperReady: true,
    kokoroReady: true,
    ...overrides,
  };
}

describe("deriveReadinessRows", () => {
  it("returns the three Capability rows in order", () => {
    const rows = deriveReadinessRows(baseInput());
    expect(rows.map((row) => row.capability)).toEqual(["reasoning", "transcription", "speech"]);
  });

  it("marks Reasoning ready when the routed Vendor has a key", () => {
    const [reasoning] = deriveReadinessRows(baseInput());
    expect(reasoning).toMatchObject({ ready: true, state: "ready" });
  });

  it("explains a missing key with the Vendor's display name", () => {
    const [reasoning] = deriveReadinessRows(
      baseInput({ reasoning: { vendorDisplayName: "Google Gemini", keyed: false } }),
    );
    expect(reasoning).toMatchObject({ ready: false, state: "not-ready" });
    expect(reasoning.detail).toContain("Google Gemini");
  });

  it("shows a download percentage while a run is in flight", () => {
    const rows = deriveReadinessRows(
      baseInput({
        whisperReady: false,
        provisioning: { phase: "running", downloadedBytes: 40, totalBytes: 100, preflightFailure: undefined },
      }),
    );
    const transcription = rows.find((row) => row.capability === "transcription");
    expect(transcription).toMatchObject({ ready: false, state: "downloading", detail: "Downloading 40%" });
  });

  it("clamps download percentage and handles a zero total", () => {
    const rows = deriveReadinessRows(
      baseInput({
        kokoroReady: false,
        provisioning: { phase: "running", downloadedBytes: 5, totalBytes: 0, preflightFailure: undefined },
      }),
    );
    const speech = rows.find((row) => row.capability === "speech");
    expect(speech?.detail).toBe("Downloading 0%");
  });

  it("surfaces a preflight failure detail when not downloading", () => {
    const rows = deriveReadinessRows(
      baseInput({
        whisperReady: false,
        provisioning: {
          phase: "failed",
          downloadedBytes: 0,
          totalBytes: 0,
          preflightFailure: { reason: "insufficient-disk", detail: "Need 2 GB free" },
        },
      }),
    );
    const transcription = rows.find((row) => row.capability === "transcription");
    expect(transcription).toMatchObject({ ready: false, state: "not-ready", detail: "Need 2 GB free" });
  });

  it("points at Repair after a failed run with no preflight failure", () => {
    const rows = deriveReadinessRows(
      baseInput({
        kokoroReady: false,
        provisioning: { phase: "failed", downloadedBytes: 0, totalBytes: 0, preflightFailure: undefined },
      }),
    );
    const speech = rows.find((row) => row.capability === "speech");
    expect(speech?.detail).toContain("Repair");
  });

  it("says not-yet-downloaded when idle and unprovisioned", () => {
    const rows = deriveReadinessRows(baseInput({ whisperReady: false }));
    const transcription = rows.find((row) => row.capability === "transcription");
    expect(transcription).toMatchObject({ ready: false, state: "not-ready", detail: "Model not downloaded yet" });
  });
});
