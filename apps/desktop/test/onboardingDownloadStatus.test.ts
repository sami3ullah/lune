import { describe, expect, it } from "vitest";

import {
  deriveOnboardingDownloadStatus,
  type OnboardingDownloadInput,
} from "../src/main/onboarding/onboardingDownloadStatus";

/**
 * Unit tests for the onboarding download-step status derivation (ticket 14: "download
 * step showing remaining progress ... preflight failures explained in plain language").
 * It folds the live Provisioning run into the single shape the step renders - a percent,
 * the phase, completion, and any preflight failure - so the bar is never a silent hang.
 */

const RUNNING: OnboardingDownloadInput = {
  phase: "running",
  downloadedBytes: 25,
  totalBytes: 100,
  preflightFailure: undefined,
};

describe("deriveOnboardingDownloadStatus", () => {
  it("reports the downloaded fraction while running", () => {
    const status = deriveOnboardingDownloadStatus(RUNNING, false);
    expect(status).toMatchObject({ percent: 25, phase: "running", complete: false });
  });

  it("reports 100% and complete once every weight is ready", () => {
    // A resumed run that verified an already-present file may report no new bytes; the
    // all-ready signal still drives the bar to 100.
    const status = deriveOnboardingDownloadStatus(
      { phase: "succeeded", downloadedBytes: 0, totalBytes: 0, preflightFailure: undefined },
      true,
    );
    expect(status).toMatchObject({ percent: 100, complete: true });
  });

  it("clamps to 0% before the total is known", () => {
    const status = deriveOnboardingDownloadStatus(
      { phase: "running", downloadedBytes: 5, totalBytes: 0, preflightFailure: undefined },
      false,
    );
    expect(status.percent).toBe(0);
  });

  it("surfaces a preflight failure in plain language", () => {
    const status = deriveOnboardingDownloadStatus(
      {
        phase: "failed",
        downloadedBytes: 0,
        totalBytes: 0,
        preflightFailure: { reason: "insufficient-disk", detail: "Need about 2 GB free to continue." },
      },
      false,
    );
    expect(status.phase).toBe("failed");
    expect(status.preflightFailure?.detail).toContain("2 GB");
  });
});
