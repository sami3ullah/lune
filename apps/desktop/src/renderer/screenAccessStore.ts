import { create } from "zustand";
import type { ScreenPermissionStateValue } from "../ipc/screenPermission";

// The renderer's view of the macOS Screen Recording permission (ticket 05). It holds
// the last state read from the main process and the actions that drive the flow -
// refresh (poll, no prompt), request (prompt on first attempt), and relaunch. The
// permission surface polls `refresh` while it is open so a grant the user makes in
// System Settings, or the needs-relaunch case, is reflected live without a restart.

/** `"unknown"` is the pre-first-read state, before the main process has answered once. */
export type RendererScreenPermissionState = ScreenPermissionStateValue | "unknown";

interface ScreenAccessState {
  permissionState: RendererScreenPermissionState;
  /** True while a request (which may show the OS prompt) is in flight. */
  isRequesting: boolean;
  /** Reads the current state without prompting; safe to call on a poll. */
  refresh: () => Promise<void>;
  /** Attempts a capture to request access, popping the OS prompt on the first try. */
  request: () => Promise<void>;
  /** Relaunches Lune so a freshly-granted permission takes effect. */
  relaunch: () => void;
  /** Opens System Settings to the Screen Recording pane (the denied case never re-prompts). */
  openSettings: () => void;
}

export const useScreenAccessStore = create<ScreenAccessState>((set) => ({
  permissionState: "unknown",
  isRequesting: false,
  refresh: async () => {
    const permissionState = await window.lune.screen.getPermissionStatus();
    set({ permissionState });
  },
  request: async () => {
    set({ isRequesting: true });
    try {
      const permissionState = await window.lune.screen.requestPermission();
      set({ permissionState });
    } finally {
      set({ isRequesting: false });
    }
  },
  relaunch: () => window.lune.screen.relaunch(),
  openSettings: () => window.lune.screen.openSettings(),
}));
