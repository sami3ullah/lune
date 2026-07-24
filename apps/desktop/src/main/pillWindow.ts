import { join } from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import { PILL_RESIZE_CHANNEL, PillContentSizeSchema } from "../ipc/pillControl";
import {
  boundsForAnchor,
  clampAnchor,
  defaultAnchor,
  type PillAnchor,
  type PillSize,
} from "./pillGeometry";

// The Pill is Lune's home surface (ticket 04): a thin, always-on-top, frameless
// window fixed top-center directly under the notch/menu bar, on every Space and above
// full-screen-ish contexts, with no dock icon or app-switcher entry. It is the one
// window the Shell shows in M1; the Chat Panel and Overlay are their own windows in
// later tickets.
//
// The window is sized to its content and kept there: it starts collapsed (just the
// bar), and the renderer reports its measured size whenever it expands into the
// menu or collapses back. Sizing to content means the transparent window never leaves
// an invisible region around the pill to swallow clicks meant for the apps behind it.
// Growth is anchored to the pill's top-center so the bar stays put while the menu
// unfolds downward. The pill is not draggable - it always sits at its home position.

/** How far below the menu bar/notch the pill sits, in logical pixels (right under the notch). */
const DEFAULT_TOP_MARGIN = 8;

/**
 * The window's initial size before the renderer reports its real measurement. It
 * only needs to be close enough to avoid a visible jump on first paint; the
 * renderer corrects it on mount.
 */
const INITIAL_COLLAPSED_SIZE: PillSize = { width: 120, height: 44 };

/** The work area of the display the pill sits on (the primary display, under its notch). */
function workAreaAt(anchor: PillAnchor) {
  return screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) })
    .workArea;
}

/**
 * Creates the Pill window and wires its hover-resize and drag-persistence. Registers
 * the pill-resize IPC as a side effect - there is exactly one Pill, so a
 * module-level registration is correct. Returns the window so the main process can
 * address it directly (e.g. streaming Kokoro speech clips to the Pill's audio output).
 */
export function createPillWindow(): BrowserWindow {
  // The anchor (pill top-center) is the single source of truth for placement. The pill is
  // fixed, so it always sits at its home: top-center of the primary display, just below the
  // notch/menu bar. Clamped defensively so an odd work area can never strand it off-screen.
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  let anchor = defaultAnchor(primaryWorkArea, DEFAULT_TOP_MARGIN);
  let currentSize: PillSize = INITIAL_COLLAPSED_SIZE;
  anchor = clampAnchor(anchor, currentSize, workAreaAt(anchor));

  const pillWindow = new BrowserWindow({
    ...boundsForAnchor(anchor, currentSize),
    show: false,
    frame: false,
    transparent: true,
    // Fully transparent backing from the first frame. Without an explicit
    // transparent backgroundColor, macOS paints the window's default (opaque) fill
    // until the window is first focused, showing a pale rounded-rect border around
    // the pill that only clears on the first click. "#00000000" removes it outright.
    backgroundColor: "#00000000",
    // No macOS rounded-corner treatment: the pill's own `rounded-full` CSS defines its
    // shape, and the window's system rounded corners would otherwise show as a pale
    // hairline arc on each side of the transparent window (visible until first focus).
    roundedCorners: false,
    resizable: false,
    // `movable` stays true so our own `setBounds` re-centres reliably as the window grows
    // for the menu and shrinks back (a non-movable window can drop the x change and leave
    // the pill shifted). The user still can't drag it: there is no drag region anywhere,
    // so there is no handle to grab - the bar is a plain click target.
    movable: true,
    hasShadow: false,
    // A background companion: no taskbar/dock entry, never stealing focus when it
    // resizes or when the user drags it (developer story 40).
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Push-to-talk mic capture starts from a global OS hotkey, not a page gesture, so
      // waive the autoplay gesture requirement - otherwise the capture AudioContext stays
      // suspended and the recorded clip comes back empty (whisper then 400s).
      autoplayPolicy: "no-user-gesture-required",
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

  // Keep the pill anchored at its top-center home while the window resizes to the
  // renderer's measured content, so the menu grows downward from a stationary bar and the
  // bar stays put horizontally as the menu widens/narrows the window.
  function applyBounds(): void {
    // Clamp only the placement used for this resize - never mutate the home `anchor`
    // itself. Mutating it let a clamp at the wide (menu-open) size stick, so closing the
    // menu re-placed the pill off-centre (it drifted left). Keeping `anchor` pristine means
    // every resize re-centres on the exact same home point.
    const placed = clampAnchor(anchor, currentSize, workAreaAt(anchor));
    pillWindow.setBounds(boundsForAnchor(placed, currentSize));
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

  pillWindow.on("closed", () => {
    ipcMain.removeListener(PILL_RESIZE_CHANNEL, handleResize);
  });

  return pillWindow;
}
