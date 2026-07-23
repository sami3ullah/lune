import { create } from "zustand";
import type { MicPermissionStateValue } from "../ipc/micPermission";

// The renderer's view of the microphone permission (ticket 11), mirroring the screen
// access store. It holds the last state read from the main process and the actions that
// drive the flow - refresh (poll, no prompt) and request (prompt on first attempt). The
// mic permission surface polls `refresh` while it is open so a grant the user makes in
// System Settings is reflected live without a restart. Unlike screen capture, the mic
// has no "needs relaunch" case, so the state set is simply granted/denied/not-determined.

/** `"unknown"` is the pre-first-read state, before the main process has answered once. */
export type RendererMicPermissionState = MicPermissionStateValue | "unknown";

interface MicAccessState {
  permissionState: RendererMicPermissionState;
  /** True while a request (which may show the OS prompt) is in flight. */
  isRequesting: boolean;
  /** Reads the current state without prompting; safe to call on a poll. */
  refresh: () => Promise<void>;
  /** Requests mic access, popping the OS prompt on the first try. */
  request: () => Promise<void>;
  /** Opens System Settings to the Microphone pane (the denied case never re-prompts). */
  openSettings: () => void;
}

export const useMicAccessStore = create<MicAccessState>((set) => ({
  permissionState: "unknown",
  isRequesting: false,
  refresh: async () => {
    const permissionState = await window.lune.voice.getMicPermissionStatus();
    set({ permissionState });
  },
  request: async () => {
    set({ isRequesting: true });
    try {
      const permissionState = await window.lune.voice.requestMicPermission();
      set({ permissionState });
    } finally {
      set({ isRequesting: false });
    }
  },
  openSettings: () => window.lune.voice.openMicSettings(),
}));
