import { create } from "zustand";
import type { AccessibilityPermissionStateValue } from "../ipc/accessibilityPermission";

// The renderer's view of the macOS Accessibility permission (M1 onboarding), mirroring
// the mic/screen access stores. Accessibility is what the global push-to-talk hook needs,
// so onboarding's permissions step reads this and drives its grant. It holds the last
// state read from the main process plus refresh (poll, no prompt) and request (pops the
// system prompt that routes to System Settings). The permissions step polls `refresh`
// while it is open so a grant the user makes in System Settings is reflected live and the
// main process can start the push-to-talk hook without a restart. macOS exposes only a
// trusted/not-trusted bit, so the state set is simply granted/not-granted.

/** `"unknown"` is the pre-first-read state, before the main process has answered once. */
export type RendererAccessibilityPermissionState = AccessibilityPermissionStateValue | "unknown";

interface AccessibilityAccessState {
  permissionState: RendererAccessibilityPermissionState;
  /** True while a request (which pops the system prompt) is in flight. */
  isRequesting: boolean;
  /** Reads the current state without prompting; safe to call on a poll. */
  refresh: () => Promise<void>;
  /** Requests Accessibility, popping the system prompt that routes to System Settings. */
  request: () => Promise<void>;
  /** Opens System Settings to the Accessibility pane (a second route to the toggle). */
  openSettings: () => void;
}

export const useAccessibilityAccessStore = create<AccessibilityAccessState>((set) => ({
  permissionState: "unknown",
  isRequesting: false,
  refresh: async () => {
    const permissionState = await window.lune.accessibility.getPermissionStatus();
    set({ permissionState });
  },
  request: async () => {
    set({ isRequesting: true });
    try {
      const permissionState = await window.lune.accessibility.requestPermission();
      set({ permissionState });
    } finally {
      set({ isRequesting: false });
    }
  },
  openSettings: () => window.lune.accessibility.openSettings(),
}));
