import type { LuneBridge } from "../preload/index";

// The preload script exposes the typed bridge on window.lune via contextBridge.
// Declaring it here gives the renderer full type-safety on the IPC surface while
// keeping the shape defined once, in the preload.
declare global {
  interface Window {
    lune: LuneBridge;
  }
}

export {};
