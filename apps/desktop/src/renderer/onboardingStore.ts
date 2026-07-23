import { create } from "zustand";
import type { SettingsCatalog, SettingsVendorId } from "../ipc/settings";
import type { KeyValidationResultValue, OnboardingDownloadStatusValue } from "../ipc/onboarding";

// The renderer's view of onboarding (ticket 14). It drives the first-run wizard: which
// step is showing, the picker catalog + which Vendors now have a key, the push-to-talk
// hotkey to show at the ready moment, and the live background-download status. The
// permission steps read the screen/mic access stores directly; this store owns the
// key/download/step state and the actions that mutate it. On load it starts the silent
// download and resumes to the furthest incomplete step, so a re-launched onboarding
// lands where the user left off rather than restarting from the welcome screen.

/** The ordered onboarding steps. */
export const ONBOARDING_STEPS = ["welcome", "keys", "permissions", "download", "ready"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

interface OnboardingStoreState {
  /** True once the first snapshot has loaded (before then the surface shows a spinner). */
  loaded: boolean;
  /** The current wizard step. */
  step: OnboardingStep;
  /** The static picker catalog (Vendors + "get a key" links), from the Core tables. */
  catalog: SettingsCatalog | null;
  /** Which Vendors currently have a stored key (the key step needs at least one). */
  keyedVendors: SettingsVendorId[];
  /** The push-to-talk hotkey token, shown at the ready moment. */
  hotkey: string;
  /** The live background-download status (progress / preflight / completion). */
  download: OnboardingDownloadStatusValue | null;

  /** Loads the snapshot, starts the silent download, and resumes to the right step. */
  load: () => Promise<void>;
  /** Jumps to a specific step. */
  goTo: (step: OnboardingStep) => void;
  /** Advances to the next step (a no-op on the last). */
  next: () => void;
  /** Returns to the previous step (a no-op on the first). */
  back: () => void;
  /**
   * Live-validates a candidate key and, on success, stores it (updating the keyed
   * Vendors so the key step can advance). Returns the verdict so the field can show a
   * specific reason on failure.
   */
  validateKey: (vendor: SettingsVendorId, key: string) => Promise<KeyValidationResultValue>;
  /** Re-reads the live download status (polled while the download step is open). */
  refreshDownload: () => Promise<void>;
  /** Persists completion and closes onboarding; the Pill is the app's home from here. */
  complete: () => void;
}

/** The furthest step a resuming user should land on, given what is already done. */
function resumeStep(
  hasKey: boolean,
  permissionsReady: boolean,
  downloadComplete: boolean,
): OnboardingStep {
  if (!hasKey) {
    return "welcome";
  }
  if (!permissionsReady) {
    return "permissions";
  }
  return downloadComplete ? "ready" : "download";
}

export const useOnboardingStore = create<OnboardingStoreState>((set, get) => ({
  loaded: false,
  step: "welcome",
  catalog: null,
  keyedVendors: [],
  hotkey: "control+alt",
  download: null,

  load: async () => {
    const snapshot = await window.lune.settings.get();
    // Start (or resume) the silent background download the moment onboarding opens, so
    // most of the ~2 GB arrives while the user completes the other steps.
    window.lune.onboarding.startDownload();
    const [download, screen, mic] = await Promise.all([
      window.lune.onboarding.downloadStatus(),
      window.lune.screen.getPermissionStatus(),
      window.lune.voice.getMicPermissionStatus(),
    ]);
    const permissionsReady = screen === "granted" && mic === "granted";
    set({
      loaded: true,
      catalog: snapshot.catalog,
      keyedVendors: snapshot.keyedVendors,
      hotkey: snapshot.values.hotkey,
      download,
      step: resumeStep(snapshot.keyedVendors.length > 0, permissionsReady, download.complete),
    });
  },

  goTo: (step) => set({ step }),
  next: () => {
    const index = ONBOARDING_STEPS.indexOf(get().step);
    set({ step: ONBOARDING_STEPS[Math.min(index + 1, ONBOARDING_STEPS.length - 1)] });
  },
  back: () => {
    const index = ONBOARDING_STEPS.indexOf(get().step);
    set({ step: ONBOARDING_STEPS[Math.max(index - 1, 0)] });
  },

  validateKey: async (vendor, key) => {
    const { result, state } = await window.lune.onboarding.validateKey({ vendor, key });
    if (result.ok) {
      set({ keyedVendors: state.keyedVendors, hotkey: state.values.hotkey });
    }
    return result;
  },

  refreshDownload: async () => {
    set({ download: await window.lune.onboarding.downloadStatus() });
  },

  complete: () => window.lune.onboarding.complete(),
}));
