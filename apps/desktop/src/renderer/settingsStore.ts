import { create } from "zustand";
import type {
  KeyValidationResultValue,
  ReadinessRow,
  SettingsCatalog,
  SettingsState,
  SettingsValues,
  SettingsVendorId,
} from "../ipc/settings";

// The renderer's view of Settings (ticket 13). It mirrors the main process's snapshot -
// the static picker catalog, the persisted values, which Vendors have a key, and the
// live readiness rows - and exposes the actions the surface calls. Every mutating
// action resolves with the new state and applies it, so the UI always re-renders from
// one consistent view (a key added immediately gates Vendor selectability, a saved
// Voice takes effect next turn, a repair kicks the download bar).

/**
 * One Vendor's live model catalogue as the picker sees it: whether a fetch is in flight,
 * the fetched model ids (featured first), and a reason to show in place of the dropdown
 * when the fetch failed. Absent until a fetch is first started for that Vendor.
 */
export interface VendorModels {
  loading: boolean;
  /** The live model ids (empty until a successful fetch). */
  list: string[];
  /** A human-readable reason the fetch failed, or null when it hasn't/didn't fail. */
  error: string | null;
}

interface SettingsStoreState {
  /** True once the first snapshot has loaded (before then the surface shows a spinner). */
  loaded: boolean;
  /** The static picker catalog (Vendors + Voices), from the Core tables. */
  catalog: SettingsCatalog | null;
  /** The persisted, applied values (what the Core routes with today). */
  values: SettingsValues | null;
  /** Which Vendors currently have a stored key (drives selectability). */
  keyedVendors: SettingsVendorId[];
  /** The live per-Capability readiness rows. */
  readiness: ReadinessRow[];
  /** Per-Vendor live model catalogues, fetched on demand from the Vendor's API. */
  models: Partial<Record<SettingsVendorId, VendorModels>>;

  /** Loads the full snapshot when the surface opens. */
  load: () => Promise<void>;
  /** Persists edited values (Vendor/Model/Voice/hotkey/streaming); applies the result. */
  save: (values: SettingsValues) => Promise<void>;
  /** Clears one Vendor's API key; applies the result. */
  clearKey: (vendor: SettingsVendorId) => Promise<void>;
  /** Live-validates and stores one Vendor's key; applies the result and returns the verdict. */
  validateKey: (vendor: SettingsVendorId, key: string) => Promise<KeyValidationResultValue>;
  /** Fetches one Vendor's live models into the store (for the model picker). */
  fetchModels: (vendor: SettingsVendorId) => Promise<void>;
  /** Re-runs/repairs Provisioning; applies the resulting state. */
  repair: () => Promise<void>;
  /** Re-reads just the readiness rows (polled while a download is in flight). */
  refreshReadiness: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => {
  /** Folds a mutating call's returned state into the store. */
  function applyState(state: SettingsState): void {
    set({ values: state.values, keyedVendors: state.keyedVendors, readiness: state.readiness });
  }

  return {
    loaded: false,
    catalog: null,
    values: null,
    keyedVendors: [],
    readiness: [],
    models: {},

    load: async () => {
      const snapshot = await window.lune.settings.get();
      set({
        loaded: true,
        catalog: snapshot.catalog,
        values: snapshot.values,
        keyedVendors: snapshot.keyedVendors,
        readiness: snapshot.readiness,
      });
    },
    save: async (values) => {
      applyState(await window.lune.settings.save(values));
    },
    clearKey: async (vendor) => {
      applyState(await window.lune.settings.setKey({ vendor, key: "" }));
      // A cleared key can no longer list models, so drop any cached catalogue for it.
      set((state) => {
        const { [vendor]: _dropped, ...rest } = state.models;
        return { models: rest };
      });
    },
    validateKey: async (vendor, key) => {
      const { result, state } = await window.lune.settings.validateKey({ vendor, key });
      applyState(state);
      // A freshly-accepted key unlocks the Vendor's live models; fetch them so the picker
      // populates without the user having to prod it.
      if (result.ok) {
        void get().fetchModels(vendor);
      }
      return result;
    },
    fetchModels: async (vendor) => {
      set((state) => ({
        models: { ...state.models, [vendor]: { loading: true, list: state.models[vendor]?.list ?? [], error: null } },
      }));
      const response = await window.lune.settings.listModels({ vendor });
      set((state) => ({
        models: {
          ...state.models,
          [vendor]: response.ok
            ? { loading: false, list: response.models, error: null }
            : { loading: false, list: [], error: response.reason },
        },
      }));
    },
    repair: async () => {
      applyState(await window.lune.settings.repair());
    },
    refreshReadiness: async () => {
      set({ readiness: await window.lune.settings.readiness() });
    },
  };
});
