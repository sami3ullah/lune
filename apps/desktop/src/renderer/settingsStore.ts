import { create } from "zustand";
import type {
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

  /** Loads the full snapshot when the surface opens. */
  load: () => Promise<void>;
  /** Persists edited values (Vendor/Model/Voice/hotkey/streaming); applies the result. */
  save: (values: SettingsValues) => Promise<void>;
  /** Sets (non-empty) or clears (empty) one Vendor's API key; applies the result. */
  setKey: (vendor: SettingsVendorId, key: string) => Promise<void>;
  /** Re-runs/repairs Provisioning; applies the resulting state. */
  repair: () => Promise<void>;
  /** Re-reads just the readiness rows (polled while a download is in flight). */
  refreshReadiness: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set) => {
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
    setKey: async (vendor, key) => {
      applyState(await window.lune.settings.setKey({ vendor, key }));
    },
    repair: async () => {
      applyState(await window.lune.settings.repair());
    },
    refreshReadiness: async () => {
      set({ readiness: await window.lune.settings.readiness() });
    },
  };
});
