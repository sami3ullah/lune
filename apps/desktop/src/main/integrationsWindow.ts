import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { INTEGRATIONS_ROUTE_HASH } from "../ipc/integrations";

// The Integrations window (M6-02): the surface opened from the Pill where the user connects
// apps (Spotify, Obsidian, Google Sheets, ...) that give Task Agents more tools, sees each
// one's status and tools, and completes sign-in. Like Settings and Skills, it is its own
// frameless, opaque, always-on-top window rendering the shared bundle selected by a URL hash
// (`#integrations`), shown with `showInactive` so opening it never yanks the user's active app
// to the background.

/** A comfortable fixed size for the Integrations surface, in logical pixels. */
const INTEGRATIONS_SIZE = { width: 460, height: 660 };

/** How far below the menu bar/notch the window's top sits (clears the Pill), in logical pixels. */
const INTEGRATIONS_TOP_MARGIN = 52;

// There is exactly one Integrations window; a module-level handle lets the toggle reuse it.
let integrationsWindow: BrowserWindow | null = null;

/** Opens the Integrations window when closed, hides it when open (the Pill menu shares this). */
export function toggleIntegrationsWindow(): void {
  if (integrationsWindow && !integrationsWindow.isDestroyed()) {
    if (integrationsWindow.isVisible()) {
      integrationsWindow.hide();
    } else {
      integrationsWindow.showInactive();
    }
    return;
  }
  integrationsWindow = createIntegrationsWindow();
}

/** The live Integrations window's web contents, or `null` - used to push live status updates. */
export function getIntegrationsWebContents(): Electron.WebContents | null {
  if (integrationsWindow && !integrationsWindow.isDestroyed()) {
    return integrationsWindow.webContents;
  }
  return null;
}

function createIntegrationsWindow(): BrowserWindow {
  // Open top-center of the primary display, just below where the Pill floats.
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(primaryWorkArea.x + (primaryWorkArea.width - INTEGRATIONS_SIZE.width) / 2);
  const y = Math.round(primaryWorkArea.y + INTEGRATIONS_TOP_MARGIN);

  const window = new BrowserWindow({
    x,
    y,
    width: INTEGRATIONS_SIZE.width,
    height: INTEGRATIONS_SIZE.height,
    show: false,
    frame: false,
    // Opaque, not transparent: a full-rectangle panel like Settings, and the dark
    // backgroundColor avoids a white flash before paint.
    transparent: false,
    backgroundColor: "#171717",
    resizable: false,
    // Draggable by a CSS app-region on its header, like the Pill, Chat Panel, and Settings.
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

  // Float above ordinary windows and on every Space, matching the Pill, so Integrations stays
  // reachable wherever the user is working.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Show without activating so opening Integrations never steals the user's focus.
  window.on("ready-to-show", () => window.showInactive());
  window.on("closed", () => {
    integrationsWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${INTEGRATIONS_ROUTE_HASH}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: INTEGRATIONS_ROUTE_HASH,
    });
  }

  return window;
}
