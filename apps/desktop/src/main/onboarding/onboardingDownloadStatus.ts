import type { ProvisioningStatus } from "@lune/core";
import type { OnboardingDownloadStatusValue } from "../../ipc/onboarding";

// The onboarding download-step view of the one Provisioning run (ticket 14: "download
// step showing remaining progress ... interrupted onboarding resumes where it left off
// ... preflight failures explained in plain language with retry"). It folds the Core's
// live Provisioning status - which the Settings readiness rows also read - into the
// single shape the onboarding download step renders: an overall percent, the run phase,
// whether every weight is now ready, and any preflight failure in plain language. Kept
// pure so the percent/complete/preflight cases are unit-tested rather than discovered
// while staring at a stuck bar.
//
// The returned shape is exactly the wire codec `OnboardingDownloadStatusValue` (ticket
// 14's IPC contract), so the schema is the single source of truth for it and assigning
// the Core's `phase` into that type is a compile-time guard: a phase added to the Core
// that the wire enum doesn't list fails to build here rather than as a runtime parse
// error at the IPC boundary (the same drift protection screenPermission gets from its
// shared tuple).

/** The Provisioning signals the onboarding download status is derived from. */
export type OnboardingDownloadInput = Pick<
  ProvisioningStatus,
  "phase" | "downloadedBytes" | "totalBytes" | "preflightFailure"
>;

/**
 * Derives the onboarding download status from the live Provisioning run and whether all
 * weights are verified. Once everything is ready the bar reads 100% regardless of the
 * byte counters (a resumed run that verified an already-present file reports no new
 * bytes); otherwise it is the downloaded fraction, clamped to 0..100 and 0 before the
 * total is known.
 */
export function deriveOnboardingDownloadStatus(
  status: OnboardingDownloadInput,
  allRuntimesReady: boolean,
): OnboardingDownloadStatusValue {
  const percent = allRuntimesReady
    ? 100
    : status.totalBytes > 0
      ? Math.max(0, Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100)))
      : 0;

  return {
    percent,
    phase: status.phase,
    complete: allRuntimesReady,
    preflightFailure: status.preflightFailure,
  };
}
