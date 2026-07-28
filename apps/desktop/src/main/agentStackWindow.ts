import { join } from "node:path";
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron";
import {
  AGENT_STACK_CONTENT_SIZE_CHANNEL,
  AGENT_STACK_ROUTE_HASH,
  AgentStackContentSizeSchema,
} from "../ipc/agentStack";

// The Agent Stack (M5-03): the background-work surface. Each running Task Agent shows as a
// status card fixed top-right under the menu bar, stacking downward; the user keeps working
// freely while agents run. Like the Pill it is a thin, frameless, transparent, always-on-top
// window sized exactly to its content (so no invisible region swallows clicks behind it), on
// every Space and above full-screen contexts. It is anchored top-right and grows downward as
// cards stack; the renderer reports its measured size and card count, and the window hides
// itself the moment the last card is dismissed.
//
// There is exactly one Agent Stack window; it is created lazily when the first agent starts
// and torn down when closed. The renderer folds the shared Task Agent event stream into cards
// (seeding from a snapshot read on mount), so this module owns only the window's shape,
// placement, and content-driven show/hide - never the card state.

/** How far from the top-right corner (under the menu bar) the stack sits, in logical pixels. */
const MARGIN = 12;

/**
 * The window's initial size before the renderer reports its real measurement. Close enough to
 * avoid a visible jump on first paint; the renderer corrects it on mount. The window stays
 * hidden until the renderer reports at least one card, so this is never shown as-is.
 */
const INITIAL_SIZE = { width: 340, height: 140 };

let agentStackWindow: BrowserWindow | null = null;
let currentSize = { ...INITIAL_SIZE };

/** The top-right bounds under the menu bar for a given content size, on the primary display. */
function topRightBounds(size: { width: number; height: number }): Electron.Rectangle {
  // `workArea` already excludes the macOS menu bar and Dock, so its top-right corner is the
  // first pixel under the menu bar at the screen's right edge - exactly where the stack pins.
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(workArea.x + workArea.width - size.width - MARGIN),
    y: Math.round(workArea.y + MARGIN),
    width: size.width,
    height: size.height,
  };
}

/** Re-pins the window to the top-right at the current content size (called on every resize). */
function applyBounds(): void {
  if (agentStackWindow && !agentStackWindow.isDestroyed()) {
    agentStackWindow.setBounds(topRightBounds(currentSize));
  }
}

/**
 * The renderer reported its content size and card count: size the window to match and keep it
 * pinned top-right, or hide it when the last card is gone. Showing is driven from here (not on
 * create) so the window never flashes at its placeholder size before the cards are laid out.
 */
function handleResize(_event: IpcMainEvent, rawSize: unknown): void {
  const parsed = AgentStackContentSizeSchema.safeParse(rawSize);
  if (!parsed.success) {
    console.error("[lune] dropping malformed agent stack resize:", parsed.error.message);
    return;
  }
  if (agentStackWindow === null || agentStackWindow.isDestroyed()) {
    return;
  }
  if (parsed.data.cardCount === 0) {
    // Empty surface: hide the window rather than leave a 0-height transparent sliver mounted.
    if (agentStackWindow.isVisible()) {
      agentStackWindow.hide();
    }
    return;
  }
  currentSize = {
    width: Math.max(1, Math.round(parsed.data.width)),
    height: Math.max(1, Math.round(parsed.data.height)),
  };
  applyBounds();
  if (!agentStackWindow.isVisible()) {
    // showInactive: surface the stack without stealing focus from the app the user is in.
    agentStackWindow.showInactive();
  }
}

/** Creates the Agent Stack window (hidden) and wires its content-size resize. */
function createAgentStackWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...topRightBounds(currentSize),
    show: false,
    frame: false,
    transparent: true,
    // Fully transparent from the first frame so macOS never paints a pale rounded-rect border
    // (the cards define their own shape in CSS), matching the Pill.
    backgroundColor: "#00000000",
    roundedCorners: false,
    resizable: false,
    // Kept movable (though never user-dragged - the cards carry no drag region) because a
    // non-movable window can drop the x change from our own `setBounds`, the same hard-won
    // lesson `pillWindow` documents; the stack repositions itself via `applyBounds`.
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Waive the autoplay gesture requirement so the soft completion chime can sound without
      // the user ever clicking into this (never-focused) window - the same waiver the Pill and
      // Overlay use for their audio.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Above full-screen apps and on every Space, so background work stays glanceable wherever
  // the user is working - matching the Pill and Overlay. (Lune fires no OS notification on
  // completion - the on-screen card and its chime are the signal - so nothing needs to render
  // above the stack in this corner.)
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${AGENT_STACK_ROUTE_HASH}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), { hash: AGENT_STACK_ROUTE_HASH });
  }

  ipcMain.on(AGENT_STACK_CONTENT_SIZE_CHANNEL, handleResize);
  window.on("closed", () => {
    ipcMain.removeListener(AGENT_STACK_CONTENT_SIZE_CHANNEL, handleResize);
    agentStackWindow = null;
    currentSize = { ...INITIAL_SIZE };
  });
  return window;
}

/**
 * Ensures the Agent Stack window exists (creating it hidden if needed) so the renderer mounts,
 * seeds its cards, and starts receiving the event stream. The window shows itself once the
 * renderer reports a card. Idempotent - safe to call on every `started` event.
 */
export function ensureAgentStackWindow(): BrowserWindow {
  if (agentStackWindow === null || agentStackWindow.isDestroyed()) {
    agentStackWindow = createAgentStackWindow();
  }
  return agentStackWindow;
}

/** The Agent Stack window's live web contents, or `null` when the window isn't open. */
export function getAgentStackWebContents(): Electron.WebContents | null {
  return agentStackWindow !== null && !agentStackWindow.isDestroyed()
    ? agentStackWindow.webContents
    : null;
}

/**
 * Brings the Agent Stack into view (e.g. when a completion notification is clicked). Uses
 * `showInactive` like every other companion surface - the user clicked a notification to
 * glance at their finished work, not to type into it, so it must not steal focus from the app
 * they're in.
 */
export function revealAgentStackWindow(): void {
  const window = ensureAgentStackWindow();
  if (!window.isVisible()) {
    window.showInactive();
  }
}
