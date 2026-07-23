import { findReasoningVendor, type ProvisioningStatus } from "@lune/core";
import type {
  KeyValidationResultValue,
  OnboardingDownloadStatusValue,
  ValidateKeyRequest,
} from "../../ipc/onboarding";
import type { SettingsState } from "../../ipc/settings";
import type { SettingsVendorId } from "../../ipc/settings";
import { SecureStorageUnavailableError } from "../settings/credentialStore";
import type { SettingsService } from "../settings/settingsService";
import { deriveOnboardingDownloadStatus } from "./onboardingDownloadStatus";
import type { OnboardingStore } from "./onboardingStore";

// The onboarding main-process composition (ticket 14): it sits between the typed
// onboarding IPC handlers and the seams the flow needs - the Settings service (which
// owns key storage + Vendor routing + readiness), the cheap key validator, the one
// Provisioning run, and the completion flag - so the handlers stay thin and the flow
// logic lives in one place. The pure logic it leans on (key validation, download-status
// derivation) is unit-tested in the Core and here; this layer is the glue.

/** The injected boundaries the onboarding service composes. */
export interface OnboardingServiceDependencies {
  /** The Settings service: stores keys, gates/routes Vendors, and reports readiness. */
  settingsService: SettingsService;
  /** The cheap key-validation call (Core `validateReasoningKey` with `fetch` injected). */
  validateKey: (vendorId: SettingsVendorId, key: string) => Promise<KeyValidationResultValue>;
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
  const { settingsService, validateKey, provisioningStatus, isAllProvisioned, startProvisioning, onboardingStore } =
    dependencies;

  /** The current Settings state, without the static catalog. */
  function currentState(): SettingsState {
    const { catalog: _catalog, ...state } = settingsService.snapshot();
    return state;
  }

  return {
    validateAndSaveKey: async ({ vendor, key }) => {
      const result = await validateKey(vendor, key);
      if (!result.ok) {
        return { result, state: currentState() };
      }

      try {
        // The key works: store it (this gates the Vendor selectable), then route to it
        // when the currently-routed Vendor still has no key, so a user who supplies only
        // (say) an Anthropic key lands on a working Vendor rather than the unkeyed Gemini
        // default. When the routed Vendor is already keyed (e.g. the default Gemini), its
        // selection is kept - Gemini stays the preferred default.
        let state = settingsService.setKey({ vendor, key });
        if (!state.keyedVendors.includes(state.values.reasoning.vendor)) {
          state = settingsService.save({
            ...state.values,
            reasoning: { vendor, modelSlot: findReasoningVendor(vendor).defaultModel },
          });
        }
        return { result, state };
      } catch (error) {
        // The key is valid but could not be stored (an unavailable OS keychain). Report
        // it as an actionable failure rather than letting the step advance with no key.
        const reason =
          error instanceof SecureStorageUnavailableError
            ? "Your key is valid, but Lune couldn't save it to your OS keychain. Check that your login keychain is unlocked and try again."
            : "Your key is valid, but Lune couldn't save it. Please try again.";
        return { result: { ok: false, reason }, state: currentState() };
      }
    },

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
