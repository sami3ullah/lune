import { type ProvisioningStatus } from "@lune/core";
import type { OnboardingDownloadStatusValue } from "../../ipc/onboarding";
import type { KeyValidationResultValue, SettingsState, ValidateKeyRequest } from "../../ipc/settings";
import type { SettingsService } from "../settings/settingsService";
import { deriveOnboardingDownloadStatus } from "./onboardingDownloadStatus";
import type { OnboardingStore } from "./onboardingStore";

// The onboarding main-process composition (ticket 14): it sits between the typed
// onboarding IPC handlers and the seams the flow needs - the Settings service (which
// owns key storage + Vendor routing + readiness + the shared validate-and-save-key
// flow), the one Provisioning run, and the completion flag - so the handlers stay thin
// and the flow logic lives in one place. The pure logic it leans on (download-status
// derivation) is unit-tested; this layer is the glue.

/** The injected boundaries the onboarding service composes. */
export interface OnboardingServiceDependencies {
  /**
   * The Settings service: stores keys, gates/routes Vendors, reports readiness, and owns
   * the shared validate-and-save-key flow the onboarding key step delegates to.
   */
  settingsService: SettingsService;
  /** The live Provisioning run snapshot (phase, progress bytes, preflight). */
  provisioningStatus: () => ProvisioningStatus;
  /** Whether every pinned Runtime's weights are verified and ready. */
  isAllProvisioned: () => boolean;
  /** Starts (or resumes) the background download of every pinned Runtime. */
  startProvisioning: () => void;
  /** The onboarding-complete flag store. */
  onboardingStore: OnboardingStore;
}

/** The onboarding operations the IPC handlers call. */
export interface OnboardingService {
  /**
   * Live-validates a candidate key and, if it works, stores it - routing the newly-keyed
   * Vendor when the currently-routed one has none, so completing onboarding yields a
   * working Lune without touching Settings. Returns the verdict and the resulting state.
   */
  validateAndSaveKey(request: ValidateKeyRequest): Promise<{ result: KeyValidationResultValue; state: SettingsState }>;
  /** Starts (or resumes) the background download; a no-op once everything is ready. */
  startDownload(): void;
  /** The download step's live progress / preflight view. */
  downloadStatus(): OnboardingDownloadStatusValue;
  /** Persists that onboarding is complete (returning users never see it again). */
  markComplete(): void;
}

export function createOnboardingService(dependencies: OnboardingServiceDependencies): OnboardingService {
  const { settingsService, provisioningStatus, isAllProvisioned, startProvisioning, onboardingStore } = dependencies;

  return {
    // The validate-store-and-route flow lives in the Settings service (the shared home for
    // key management), so the onboarding key step and the Settings key entry behave
    // identically. This is a thin delegation.
    validateAndSaveKey: (request) => settingsService.validateAndSaveKey(request),

    startDownload: () => {
      // Idempotent: the controller no-ops a re-trigger while running and resumes partial
      // downloads on a fresh start, so a resumed onboarding never restarts the ~2 GB.
      if (isAllProvisioned()) {
        return;
      }
      startProvisioning();
    },

    downloadStatus: () => deriveOnboardingDownloadStatus(provisioningStatus(), isAllProvisioned()),

    markComplete: () => onboardingStore.markComplete(),
  };
}
