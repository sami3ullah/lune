import { join } from "node:path";
import { BrowserWindow, screen } from "electron";

// The Chat Panel window (ticket 06): the conversation surface opened from the Pill. It
// is its own frameless, transparent, always-on-top window - a larger sibling of the
// Pill, sharing its design language - rather than an expansion of the tiny pill bar.
//
// Focus discipline (ticket 06 acceptance: never steal focus more than necessary): the
// panel is shown with `showInactive`, so opening it does not yank the user's active app
// to the background. It is still focusable, so clicking into the input focuses it for
// typing - focus is taken only when the user actually reaches for the panel.
//
// It renders the same renderer bundle as the Pill, selected by the URL hash (`#chat`):
// the renderer's entry branches on the hash to mount the Chat Panel instead of the Pill.

/** A comfortable fixed size for the conversation surface, in logical pixels. */
const CHAT_PANEL_SIZE = { width: 384, height: 560 };

/** How far below the menu bar/notch the panel's top sits (clears the Pill), in logical pixels. */
const CHAT_PANEL_TOP_MARGIN = 52;

/** The renderer hash that tells the entry point to mount the Chat Panel surface. */
const CHAT_PANEL_ROUTE_HASH = "chat";

// There is exactly one Chat Panel; a module-level handle lets the toggle reuse it.
let chatPanelWindow: BrowserWindow | null = null;

/**
 * The Chat Panel's WebContents when it is open and alive, else `null`. A voice turn
 * (ticket 11) streams its conversation events here so the transcript and reply appear in
 * the same unified history as typed turns - when the panel is closed there is nothing to
 * render live (the Core still commits the turn and the durable store persists it).
 */
export function getChatPanelWebContents(): Electron.WebContents | null {
  if (chatPanelWindow && !chatPanelWindow.isDestroyed()) {
    return chatPanelWindow.webContents;
  }
  return null;
}

/** Opens the Chat Panel when closed, hides it when open (the Pill menu + close button share this). */
export function toggleChatPanelWindow(): void {
  if (chatPanelWindow && !chatPanelWindow.isDestroyed()) {
    if (chatPanelWindow.isVisible()) {
      chatPanelWindow.hide();
    } else {
      chatPanelWindow.showInactive();
    }
    return;
  }
  chatPanelWindow = createChatPanelWindow();
}

function createChatPanelWindow(): BrowserWindow {
  // Open top-center of the primary display, just below where the Pill floats.
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(primaryWorkArea.x + (primaryWorkArea.width - CHAT_PANEL_SIZE.width) / 2);
  const y = Math.round(primaryWorkArea.y + CHAT_PANEL_TOP_MARGIN);

  const panelWindow = new BrowserWindow({
    x,
    y,
    width: CHAT_PANEL_SIZE.width,
    height: CHAT_PANEL_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    // Draggable by a CSS app-region on its header, like the Pill.
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

  // Float above ordinary windows and on every Space, matching the Pill, so the panel
  // stays reachable wherever the user is working.
  panelWindow.setAlwaysOnTop(true, "screen-saver");
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Show without activating so opening the panel never steals the user's focus.
  panelWindow.on("ready-to-show", () => panelWindow.showInactive());
  panelWindow.on("closed", () => {
    chatPanelWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void panelWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${CHAT_PANEL_ROUTE_HASH}`);
  } else {
    void panelWindow.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: CHAT_PANEL_ROUTE_HASH,
    });
  }

  return panelWindow;
}
