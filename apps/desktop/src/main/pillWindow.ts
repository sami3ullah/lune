import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { PILL_RESIZE_CHANNEL, PillContentSizeSchema } from "../ipc/pillControl";
import {
  anchorFromBounds,
  boundsForAnchor,
  clampAnchor,
  defaultAnchor,
  type PillAnchor,
  type PillRect,
  type PillSize,
} from "./pillGeometry";
import { PillPositionStore } from "./pillPositionStore";

// The Pill is Lune's home surface (ticket 04): a thin, always-on-top, frameless
// window floating top-center under the notch/menu bar, on every Space and above
// full-screen-ish contexts, with no dock icon or app-switcher entry. It is the one
// window the Shell shows in M1; the Chat Panel and Overlay are their own windows in
// later tickets.
//
// The window is sized to its content and kept there: it starts collapsed (just the
// bar), and the renderer reports its measured size whenever it expands into the
// hover menu or collapses back. Sizing to content means the transparent window
// never leaves an invisible region around the pill to swallow clicks meant for the
// apps behind it. Growth is anchored to the pill's top-center so the bar stays put
// while the menu unfolds downward.

/** How far below the menu bar/notch the pill sits by default, in logical pixels. */
const DEFAULT_TOP_MARGIN = 8;

/**
 * The window's initial size before the renderer reports its real measurement. It
 * only needs to be close enough to avoid a visible jump on first paint; the
 * renderer corrects it on mount.
 */
const INITIAL_COLLAPSED_SIZE: PillSize = { width: 168, height: 40 };

/** Debounce for persisting a drag so a flick of moves becomes one write. */
const POSITION_SAVE_DEBOUNCE_MS = 300;

/** The work area of the display the pill currently sits on (handles external monitors). */
function workAreaAt(anchor: PillAnchor) {
  return screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) })
    .workArea;
}

/**
 * Creates the Pill window and wires its hover-resize and drag-persistence. Registers
 * the pill-resize IPC as a side effect - there is exactly one Pill, so a
 * module-level registration is correct.
 */
export function createPillWindow(): void {
  const positionStore = new PillPositionStore(
    join(app.getPath("userData"), "pill-position.json"),
    (filePath) => readFileSync(filePath, "utf8"),
    (filePath, contents) => writeFileSync(filePath, contents),
  );

  // The anchor (pill top-center) is the single source of truth for placement. Start
  // from the saved position, falling back to top-center of the primary display, and
  // clamp so a stale saved anchor (display since unplugged) can never strand the
  // pill off-screen.
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  let anchor = positionStore.load() ?? defaultAnchor(primaryWorkArea, DEFAULT_TOP_MARGIN);
  let currentSize: PillSize = INITIAL_COLLAPSED_SIZE;
  anchor = clampAnchor(anchor, currentSize, workAreaAt(anchor));

  const pillWindow = new BrowserWindow({
    ...boundsForAnchor(anchor, currentSize),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    // The pill is draggable via a CSS app-region on the bar; `movable` lets that
    // OS-level drag reposition the window.
    movable: true,
    hasShadow: false,
    // A background companion: no taskbar/dock entry, never stealing focus when it
    // resizes or when the user drags it (developer story 40).
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // Float above ordinary windows and full-screen-ish contexts, on every Space.
  // `screen-saver` level sits above full-screen apps; visibleOnFullScreen keeps the
  // pill present when another app is full-screen (user stories 12 & 16).
  pillWindow.setAlwaysOnTop(true, "screen-saver");
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  pillWindow.on("ready-to-show", () => pillWindow.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void pillWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void pillWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // The last bounds we set ourselves (a hover resize), used to tell our own moves
  // apart from a user drag. A boolean flag is unreliable here: macOS emits `move`
  // asynchronously after `setBounds`, by which point a flag would already be reset.
  // Comparing the moved-to bounds against the ones we last applied is robust to that
  // timing - a user drag lands the window somewhere we did not put it.
  let lastAppliedBounds: PillRect | null = null;

  function boundsEqual(a: PillRect, b: PillRect): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function applyBounds(): void {
    // Re-clamp against the display the pill is on so a resize near an edge (menu
    // unfolding past the screen bottom) nudges the whole window back into view.
    anchor = clampAnchor(anchor, currentSize, workAreaAt(anchor));
    lastAppliedBounds = boundsForAnchor(anchor, currentSize);
    pillWindow.setBounds(lastAppliedBounds);
  }

  // Resize the window to whatever the renderer measured, keeping the pill's
  // top-center fixed so the menu grows downward from a stationary bar.
  function handleResize(_event: Electron.IpcMainEvent, rawSize: unknown): void {
    const parsed = PillContentSizeSchema.safeParse(rawSize);
    if (!parsed.success) {
      console.error("[lune] dropping malformed pill resize:", parsed.error.message);
      return;
    }
    currentSize = { width: Math.round(parsed.data.width), height: Math.round(parsed.data.height) };
    applyBounds();
  }
  ipcMain.on(PILL_RESIZE_CHANNEL, handleResize);

  // The user dragged the pill: recover the new anchor from the window's bounds,
  // clamp it, and persist (debounced) so the position survives a restart. Moves to
  // bounds we set ourselves (hover resize) are ignored.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persistAnchor(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    positionStore.save(anchor);
  }
  function handleUserMove(): void {
    const bounds = pillWindow.getBounds();
    if (lastAppliedBounds && boundsEqual(bounds, lastAppliedBounds)) {
      return;
    }
    // Clamp against the display the pill was dragged ONTO (derived from the new
    // bounds), not the one it left - otherwise a drag to a second monitor is
    // confined to the old monitor's work area and snaps back (user stories 16 & 14).
    const draggedAnchor = anchorFromBounds(bounds);
    anchor = clampAnchor(draggedAnchor, currentSize, workAreaAt(draggedAnchor));
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(persistAnchor, POSITION_SAVE_DEBOUNCE_MS);
  }
  pillWindow.on("move", handleUserMove);

  pillWindow.on("closed", () => {
    ipcMain.removeListener(PILL_RESIZE_CHANNEL, handleResize);
    // Flush a pending debounced save synchronously: a drag immediately followed by
    // Quit (within the debounce window) must still persist that final position.
    if (saveTimer) {
      persistAnchor();
    }
  });
}
