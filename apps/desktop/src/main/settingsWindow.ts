import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { SETTINGS_ROUTE_HASH } from "../ipc/settings";

// The Settings window (ticket 13): the persistent control surface opened from the
// Pill. Like the Chat Panel, it is its own frameless, transparent, always-on-top
// window sharing the Pill's design language, and it renders the same renderer bundle
// selected by a URL hash (`#settings`). It is shown with `showInactive` so opening it
// never yanks the user's active app to the background, but stays focusable so a click
// into a key field or picker takes focus only when the user reaches for it.

/** A comfortable fixed size for the control surface, in logical pixels. */
const SETTINGS_SIZE = { width: 420, height: 620 };

/** How far below the menu bar/notch the window's top sits (clears the Pill), in logical pixels. */
const SETTINGS_TOP_MARGIN = 52;

// There is exactly one Settings window; a module-level handle lets the toggle reuse it.
let settingsWindow: BrowserWindow | null = null;

/** Opens the Settings window when closed, hides it when open (the Pill menu shares this). */
export function toggleSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isVisible()) {
      settingsWindow.hide();
    } else {
      settingsWindow.showInactive();
    }
    return;
  }
  settingsWindow = createSettingsWindow();
}

function createSettingsWindow(): BrowserWindow {
  // Open top-center of the primary display, just below where the Pill floats.
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(primaryWorkArea.x + (primaryWorkArea.width - SETTINGS_SIZE.width) / 2);
  const y = Math.round(primaryWorkArea.y + SETTINGS_TOP_MARGIN);

  const window = new BrowserWindow({
    x,
    y,
    width: SETTINGS_SIZE.width,
    height: SETTINGS_SIZE.height,
    show: false,
    frame: false,
    // Opaque, not transparent: the surface is a full-rectangle panel (no rounded window
    // corners to preserve), and a native `<select>`/`<datalist>` popup - the Voice and
    // per-Vendor model pickers - crashes the GPU process when opened inside a transparent
    // frameless window on macOS. An opaque window renders the popups natively and safely;
    // the dark backgroundColor also avoids a white flash before the renderer paints.
    transparent: false,
    backgroundColor: "#171717",
    resizable: false,
    // Draggable by a CSS app-region on its header, like the Pill and Chat Panel.
    movable: true,
    hasShadow: true,
    // A background companion: no taskbar/dock entry (developer story 40).
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // Float above ordinary windows and on every Space, matching the Pill, so Settings
  // stays reachable wherever the user is working.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Show without activating so opening Settings never steals the user's focus.
  window.on("ready-to-show", () => window.showInactive());
  window.on("closed", () => {
    settingsWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${SETTINGS_ROUTE_HASH}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: SETTINGS_ROUTE_HASH,
    });
  }

  return window;
}
