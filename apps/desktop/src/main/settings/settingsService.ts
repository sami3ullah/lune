import {
  findReasoningVendor,
  KOKORO_VOICES,
  REASONING_VENDOR_IDS,
  REASONING_VENDORS,
  type ProvisionableRuntimeId,
  type ProvisioningStatus,
} from "@lune/core";
import type {
  ReadinessRow,
  SetApiKeyRequest,
  SettingsCatalog,
  SettingsSnapshot,
  SettingsState,
  SettingsValues,
} from "../../ipc/settings";
import { deriveReadinessRows } from "./readiness";
import { validateHotkeyToken } from "../../ipc/hotkey";
import type { CredentialStore } from "./credentialStore";
import type { AppSettings, SettingsStore } from "./settingsStore";

// The Settings service (ticket 13): the main-process composition that turns the
// Settings stores + Core signals into the snapshots the renderer reads and applies the
// edits it sends. It sits between the typed IPC handlers (in the main entry) and the
// three seams below - the config-file SettingsStore, the OS-encrypted CredentialStore,
// and the Provisioning Capability - so the handlers stay thin and the read/apply logic
// lives in one place. All the domain logic it leans on (readiness derivation, hotkey
// validation, tolerant parse) is pure and unit-tested; this layer is the glue.

/** The injected boundaries the Settings service composes. */
export interface SettingsServiceDependencies {
  /** The config file the Shell writes and the Core reads (reasoning/speech/toggle/hotkey). */
  settingsStore: SettingsStore;
  /** The OS-encrypted Vendor API-key store (gates Vendor selectability + readiness). */
  credentialStore: CredentialStore;
  /** The live Provisioning run snapshot (phase, progress, preflight). */
  provisioningStatus: () => ProvisioningStatus;
  /** Whether a Runtime's weights are provisioned + verified (whisper / kokoro). */
  isRuntimeReady: (runtimeId: ProvisionableRuntimeId) => boolean;
  /** Re-runs/repairs Provisioning (re-download broken or missing weights). */
  startRepair: () => void;
  /** Reloads the Core routing config after a save so the next turn uses it (no restart). */
  reloadRouting: () => void;
}

/** The Settings operations the IPC handlers call. */
export interface SettingsService {
  /** The full snapshot the Settings window reads on open (static catalog + live state). */
  snapshot(): SettingsSnapshot;
  /** Persists edited Vendor/Model/Voice/hotkey/streaming values; returns the new state. */
  save(values: SettingsValues): SettingsState;
  /** Sets or clears one Vendor's API key in OS-encrypted storage; returns the new state. */
  setKey(request: SetApiKeyRequest): SettingsState;
  /** Re-runs/repairs Provisioning; returns the state (readiness now reflects the run). */
  repair(): SettingsState;
  /** Just the live readiness rows (for polling the download percentage). */
  readiness(): ReadinessRow[];
  /** The live streaming-text toggle, for the Overlay bubble gate. */
  streamingTextEnabled(): boolean;
}

/** Builds the static picker catalog once from the Core Vendor table + Voice list. */
function buildCatalog(): SettingsCatalog {
  return {
    vendors: REASONING_VENDOR_IDS.map((vendorId) => {
      const vendor = REASONING_VENDORS[vendorId];
      return {
        id: vendor.id,
        displayName: vendor.displayName,
        defaultModel: vendor.defaultModel,
        modelShortlist: [...vendor.modelShortlist],
      };
    }),
    voices: [...KOKORO_VOICES],
  };
}

export function createSettingsService(dependencies: SettingsServiceDependencies): SettingsService {
  const { settingsStore, credentialStore, provisioningStatus, isRuntimeReady, startRepair, reloadRouting } =
    dependencies;

  const catalog = buildCatalog();

  /** The live readiness rows, derived from the routed Vendor's key + the Provisioning run. */
  function readiness(): ReadinessRow[] {
    const settings = settingsStore.read();
    const routedVendor = findReasoningVendor(settings.reasoning.vendor);
    const status = provisioningStatus();
    return deriveReadinessRows({
      reasoning: {
        vendorDisplayName: routedVendor.displayName,
        keyed: credentialStore.hasKey(settings.reasoning.vendor),
      },
      provisioning: {
        phase: status.phase,
        downloadedBytes: status.downloadedBytes,
        totalBytes: status.totalBytes,
        preflightFailure: status.preflightFailure,
      },
      whisperReady: isRuntimeReady("whisper"),
      kokoroReady: isRuntimeReady("kokoro"),
    });
  }

  /** The current dynamic state: persisted values, keyed Vendors, readiness rows. */
  function state(): SettingsState {
    const settings = settingsStore.read();
    return {
      values: {
        reasoning: { vendor: settings.reasoning.vendor, modelSlot: settings.reasoning.modelSlot },
        speech: { voice: settings.speech.voice },
        streamingText: settings.streamingText,
        hotkey: settings.hotkey,
      },
      keyedVendors: credentialStore.keyedVendors(),
      readiness: readiness(),
    };
  }

  return {
    snapshot: () => ({ catalog, ...state() }),

    save: (values) => {
      // Sanitize the hotkey defensively: the wire schema only fixes it as a non-empty
      // string, but the ordering / at-least-two-modifiers rules live in
      // validateHotkeyToken. An invalid combo keeps the previously-persisted hotkey
      // rather than corrupting it (the editor already rejects invalid combos before
      // Save is offered).
      const current = settingsStore.read();
      const hotkeyValidation = validateHotkeyToken(values.hotkey);
      const next: AppSettings = {
        reasoning: { vendor: values.reasoning.vendor, modelSlot: values.reasoning.modelSlot },
        speech: { voice: values.speech.voice },
        streamingText: values.streamingText,
        hotkey: hotkeyValidation.ok ? hotkeyValidation.token : current.hotkey,
      };
      settingsStore.write(next);
      // The Core watches the same file, but the default userData path may have had no
      // watcher (first run before the file existed), so reload explicitly - the next
      // turn then routes to the new Vendor/Model/Voice with no restart.
      reloadRouting();
      return state();
    },

    setKey: (request) => {
      credentialStore.setKey(request.vendor, request.key);
      return state();
    },

    repair: () => {
      startRepair();
      return state();
    },

    readiness,

    streamingTextEnabled: () => settingsStore.getStreamingText(),
  };
}
