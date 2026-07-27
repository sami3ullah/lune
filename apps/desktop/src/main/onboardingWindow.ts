import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { ONBOARDING_ROUTE_HASH } from "../ipc/onboarding";

// The onboarding window (ticket 14): the jargon-free first run. Unlike the Pill's
// satellite windows (Chat Panel, Settings), which open without stealing focus, this is
// the user's whole task on first launch, so it opens centered and focused - the user is
// meant to read it, enter a key, and grant permissions. It renders the same renderer
// bundle as every other surface, selected by the URL hash (`#onboarding`). It exists
// only until onboarding completes; afterwards the Pill is the app's home and this window
// is never created again (the completion flag is checked before it is opened).

/** A comfortable fixed size for the first-run experience, in logical pixels. */
const ONBOARDING_SIZE = { width: 560, height: 640 };

// There is exactly one onboarding window; a module-level handle lets the completion
// path close it.
let onboardingWindow: BrowserWindow | null = null;

/** Opens the onboarding window (reusing it if already open), centered on the primary display. */
export function openOnboardingWindow(): BrowserWindow {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return onboardingWindow;
  }

  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(primaryWorkArea.x + (primaryWorkArea.width - ONBOARDING_SIZE.width) / 2);
  const y = Math.round(primaryWorkArea.y + (primaryWorkArea.height - ONBOARDING_SIZE.height) / 2);

  const window = new BrowserWindow({
    x,
    y,
    width: ONBOARDING_SIZE.width,
    height: ONBOARDING_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    // Draggable by a CSS app-region on its header, like the Pill and its windows.
    movable: true,
    hasShadow: false,
    // A background companion: no taskbar/dock entry (developer story 40).
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // Float above ordinary windows and on every Space, matching the Pill, so onboarding
  // stays put while the user reaches for System Settings to grant a permission.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Unlike the satellite windows, onboarding is the first-run task, so show it focused.
  window.on("ready-to-show", () => window.show());
  window.on("closed", () => {
    onboardingWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${ONBOARDING_ROUTE_HASH}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: ONBOARDING_ROUTE_HASH,
    });
  }

  onboardingWindow = window;
  return window;
}

/** Closes the onboarding window once the flow completes; a no-op if it is already gone. */
export function closeOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close();
  }
}

/**
 * The onboarding window's current global-desktop bounds, or `null` when it is closed. Used
 * to keep the cursor-riding intro video (M3-03) clear of the wizard: the main process
 * converts these into each Overlay window's local space so the card never covers onboarding.
 */
export function getOnboardingWindowBounds(): { x: number; y: number; width: number; height: number } | null {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    return onboardingWindow.getBounds();
  }
  return null;
}
