import { create } from "zustand";
import type {
  AddIntegrationRequest,
  Integration,
  IntegrationActionResult,
  IntegrationPreset,
  IntegrationsSnapshot,
} from "../ipc/integrations";

// The renderer's view of Integrations (M6-02). It mirrors the main process's snapshot - the
// addable catalog plus the user's configured integrations - and exposes the actions the tab
// calls. Every mutating action resolves with the new snapshot and applies it, so the tab
// re-renders from one consistent view. Unlike Skills, integration status also changes
// asynchronously (a server connecting, going ready, or dropping), so the store subscribes to a
// live push channel and re-applies each snapshot the main process sends.

interface IntegrationsStoreState {
  /** True once the first snapshot has loaded. */
  loaded: boolean;
  /** The addable flagship catalog. */
  presets: IntegrationPreset[];
  /** The user's configured integrations, with live status + tools. */
  integrations: Integration[];

  /** Loads the full snapshot when the surface opens. */
  load: () => Promise<void>;
  /** Subscribes to live status pushes; returns an unsubscribe to call on unmount. */
  subscribe: () => () => void;
  /** Adds an integration (preset or custom); applies the resulting snapshot. */
  add: (request: AddIntegrationRequest) => Promise<void>;
  /** Removes an integration entirely; applies the resulting snapshot. */
  remove: (id: string) => Promise<void>;
  /** Turns one integration on or off; applies the resulting snapshot. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Retries one integration's connection; applies the resulting snapshot. */
  refresh: (id: string) => Promise<void>;
  /** Saves (or clears) one integration's guided credential values; applies the snapshot. */
  setCredentials: (id: string, values: Record<string, string>) => Promise<void>;
  /** Begins an OAuth integration's sign-in; applies the snapshot and returns the verdict. */
  startAuth: (id: string) => Promise<IntegrationActionResult>;
}

export const useIntegrationsStore = create<IntegrationsStoreState>((set) => {
  const apply = (snapshot: IntegrationsSnapshot): void => {
    set({ loaded: true, presets: snapshot.presets, integrations: snapshot.integrations });
  };

  return {
    loaded: false,
    presets: [],
    integrations: [],

    load: async () => {
      apply(await window.lune.integrations.list());
    },
    subscribe: () => window.lune.integrations.onChanged(apply),
    add: async (request) => {
      apply(await window.lune.integrations.add(request));
    },
    remove: async (id) => {
      apply(await window.lune.integrations.remove({ id }));
    },
    setEnabled: async (id, enabled) => {
      apply(await window.lune.integrations.setEnabled({ id, enabled }));
    },
    refresh: async (id) => {
      apply(await window.lune.integrations.refresh({ id }));
    },
    setCredentials: async (id, values) => {
      apply(await window.lune.integrations.setCredentials({ id, values }));
    },
    startAuth: async (id) => {
      const { result, snapshot } = await window.lune.integrations.startAuth({ id });
      apply(snapshot);
      return result;
    },
  };
});
