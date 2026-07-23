import { join } from "node:path";
import { BrowserWindow, ipcMain, screen, type Display } from "electron";
import {
  OVERLAY_EVENT_CHANNEL,
  OVERLAY_IDLE_CHANNEL,
  OVERLAY_ROUTE_HASH,
  type OverlayEvent,
} from "../../ipc/overlayControl";

// The Overlay windows (ticket 07): Lune's playful cursor + response bubble live in a
// full-screen, click-through, focus-less window - one per connected display, so the
// cursor can point at the correct monitor and follow across a multi-monitor setup.
//
// Each window is transparent and passes every click straight through
// (`setIgnoreMouseEvents`), so nothing behind it ever becomes uninteractive and it
// never steals focus (ticket 07 acceptance). The windows are created hidden and shown
// only for an interaction; when the renderer finishes fading out it signals idle and
// the window is hidden again, so no full-screen transparent surface is left mounted
// between turns (and a stale cursor can't be caught in the next turn's screenshot).
//
// This is the untested OS-and-pixels edge; the pointing math it serves
// (`overlayGeometry`) and the flight/animation (`overlayCursorFlight`) are the tested
// core. It is written platform-neutrally so the M7 Windows port needs no change here.

/** A live Overlay window bound to one display. */
interface OverlayWindowEntry {
  displayId: number;
  window: BrowserWindow;
}

/**
 * Owns the per-display Overlay windows and addresses them individually. The main
 * process resolves which display an interaction (and any pointing) belongs on and
 * sends that window its events; a window that receives none stays hidden and dormant.
 */
export class OverlayWindowManager {
  private entries: OverlayWindowEntry[] = [];
  private destroyed = false;

  constructor() {
    // Rebuild the window set whenever the display configuration changes (a monitor
    // plugged in, unplugged, or rearranged) so a display never ends up without an
    // overlay - the daily sleep/wake + dock/undock case (user story 43).
    screen.on("display-added", this.rebuild);
    screen.on("display-removed", this.rebuild);
    screen.on("display-metrics-changed", this.rebuild);

    // The renderer signals when it has faded fully out; hide that window so it stops
    // compositing until the next interaction.
    ipcMain.on(OVERLAY_IDLE_CHANNEL, this.handleIdleSignal);
  }

  /** Creates the initial window per connected display. Call once the app is ready. */
  start(): void {
    this.rebuild();
  }

  /**
   * Shows the Overlay on the given display (if it isn't already) and sends it one
   * event. Showing is inactive so the user's focused app is never disturbed. A
   * display with no overlay window (unknown id) is a no-op.
   */
  sendToDisplay(displayId: number, event: OverlayEvent): void {
    const entry = this.entries.find((candidate) => candidate.displayId === displayId);
    if (!entry || entry.window.isDestroyed()) {
      return;
    }
    if (!entry.window.isVisible()) {
      entry.window.showInactive();
    }
    entry.window.webContents.send(OVERLAY_EVENT_CHANNEL, event);
  }

  /**
   * Hides every Overlay window immediately. Called right before a screen capture so
   * the overlay can never photograph its own cursor/bubble into the answer's context.
   */
  hideAll(): void {
    for (const entry of this.entries) {
      if (!entry.window.isDestroyed() && entry.window.isVisible()) {
        entry.window.hide();
      }
    }
  }

  /** The display id whose bounds contain `screenPoint`, or the primary display's id. */
  displayIdAt(screenPoint: { x: number; y: number }): number {
    return screen.getDisplayNearestPoint(screenPoint).id;
  }

  /** Tears down the manager: removes listeners and closes every window. */
  dispose(): void {
    this.destroyed = true;
    screen.removeListener("display-added", this.rebuild);
    screen.removeListener("display-removed", this.rebuild);
    screen.removeListener("display-metrics-changed", this.rebuild);
    ipcMain.removeListener(OVERLAY_IDLE_CHANNEL, this.handleIdleSignal);
    for (const entry of this.entries) {
      if (!entry.window.isDestroyed()) {
        entry.window.destroy();
      }
    }
    this.entries = [];
  }

  // A display change rebuilds from scratch: close the old windows and make one per
  // current display. Rebuilding (rather than diffing) keeps the mapping simple and is
  // cheap - these windows are created hidden and only shown during an interaction.
  private rebuild = (): void => {
    if (this.destroyed) {
      return;
    }
    for (const entry of this.entries) {
      if (!entry.window.isDestroyed()) {
        entry.window.destroy();
      }
    }
    this.entries = screen.getAllDisplays().map((display) => ({
      displayId: display.id,
      window: this.createOverlayWindow(display),
    }));
  };

  private handleIdleSignal = (event: Electron.IpcMainEvent): void => {
    const entry = this.entries.find(
      (candidate) => candidate.window.webContents === event.sender,
    );
    if (entry && !entry.window.isDestroyed() && entry.window.isVisible()) {
      entry.window.hide();
    }
  };

  private createOverlayWindow(display: Display): BrowserWindow {
    const overlayWindow = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      // Never a taskbar/dock entry, never focusable: the overlay is a passive companion
      // surface, so it can never steal focus from the user's app (ticket 07 acceptance).
      skipTaskbar: true,
      focusable: false,
      fullscreenable: false,
      // Enter/leave events let the click-through forwarding stay off (see below); we
      // never want the overlay to react to the mouse, so forwarding is disabled.
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: false,
      },
    });

    // Click-through: every mouse event passes to whatever is behind the overlay, so
    // nothing the overlay covers becomes uninteractive. `forward: false` keeps the
    // renderer from receiving move events too - the overlay is purely presentational.
    overlayWindow.setIgnoreMouseEvents(true);

    // Float above ordinary windows and full-screen apps, on every Space, so the cursor
    // can point over whatever the user is looking at.
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (process.env.ELECTRON_RENDERER_URL) {
      void overlayWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${OVERLAY_ROUTE_HASH}`);
    } else {
      void overlayWindow.loadFile(join(__dirname, "../renderer/index.html"), {
        hash: OVERLAY_ROUTE_HASH,
      });
    }

    return overlayWindow;
  }
}
