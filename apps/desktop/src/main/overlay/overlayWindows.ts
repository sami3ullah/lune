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
// never steals focus (ticket 07 acceptance). The windows are shown always (like v1's
// per-screen overlay panels) so Lune's playful cursor can follow the real mouse: the
// manager polls the global cursor position each tick and streams it, converted into the
// cursor's-display-local space, to that display's window (`cursor-move`), telling the
// window it left behind to stop drawing the following buddy (`cursor-leave`).
//
// Because Electron's `desktopCapturer` photographs the whole screen - the overlay
// window included - the following cursor must be *suspended* (poll stopped + every
// window hidden) around each screen capture, not merely hidden, or the 60fps poll would
// re-show it mid-capture and the cursor would leak into the turn's screenshot. The main
// process brackets each capture with `suspendFollowing()`/`resumeFollowing()`.
//
// This is the untested OS-and-pixels edge; the pointing math it serves
// (`overlayGeometry`) and the flight/animation (`overlayCursorFlight`) are the tested
// core. It is written platform-neutrally so the M7 Windows port needs no change here.

/** How often the global cursor position is polled and streamed to the overlay (~60fps). */
const CURSOR_FOLLOW_POLL_INTERVAL_MS = 16;

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
  /** The running cursor-follow poll, or `null` when following is suspended/stopped. */
  private cursorFollowTimer: ReturnType<typeof setInterval> | null = null;
  /** The display the cursor was last seen on, so a display change can send `cursor-leave`. */
  private cursorDisplayId: number | null = null;
  /** True while a screen capture is in flight: following is paused and windows stay hidden. */
  private followingSuspended = false;

  constructor() {
    // Rebuild the window set whenever the display configuration changes (a monitor
    // plugged in, unplugged, or rearranged) so a display never ends up without an
    // overlay - the daily sleep/wake + dock/undock case (user story 43).
    screen.on("display-added", this.rebuild);
    screen.on("display-removed", this.rebuild);
    screen.on("display-metrics-changed", this.rebuild);

    // Legacy idle signal (ticket 07): with the always-on following cursor the renderer
    // no longer fades fully out between turns, so this rarely fires; kept so an explicit
    // idle signal still hides a window harmlessly.
    ipcMain.on(OVERLAY_IDLE_CHANNEL, this.handleIdleSignal);
  }

  /**
   * Creates one window per display, shows them, and starts the cursor-follow poll. Call
   * once the app is ready.
   */
  start(): void {
    this.rebuild();
    this.resumeFollowing();
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
   * Sends one event to every Overlay window that is currently drawing (visible). Used
   * for display-agnostic state the buddy shows wherever the cursor happens to be - e.g.
   * the spoken caption line - so it appears on whichever display the buddy is on without
   * the caller resolving the cursor's display. Never forces a window visible (following's
   * suspend/rebuild owns visibility).
   */
  broadcast(event: OverlayEvent): void {
    for (const entry of this.entries) {
      if (!entry.window.isDestroyed() && entry.window.isVisible()) {
        entry.window.webContents.send(OVERLAY_EVENT_CHANNEL, event);
      }
    }
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

  /**
   * Suspends the following cursor around a screen capture: stops the poll and hides
   * every window, so the poll cannot re-show the overlay mid-capture and leak Lune's
   * cursor into the screenshot. Pair with {@link resumeFollowing} once the capture is
   * done. Idempotent.
   */
  suspendFollowing(): void {
    this.followingSuspended = true;
    this.stopCursorFollow();
    this.hideAll();
  }

  /**
   * Resumes the following cursor after a capture (or at startup): shows every window and
   * restarts the poll. The next tick re-resolves the cursor's display, so following
   * picks up wherever the mouse now is. A no-op once disposed.
   */
  resumeFollowing(): void {
    if (this.destroyed) {
      return;
    }
    this.followingSuspended = false;
    this.showAllInactive();
    this.startCursorFollow();
  }

  /** The display id whose bounds contain `screenPoint`, or the primary display's id. */
  displayIdAt(screenPoint: { x: number; y: number }): number {
    return screen.getDisplayNearestPoint(screenPoint).id;
  }

  /** Tears down the manager: stops the poll, removes listeners, and closes every window. */
  dispose(): void {
    this.destroyed = true;
    this.stopCursorFollow();
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
  // cheap. Unless a capture is in flight, the fresh windows are shown so the following
  // cursor keeps drawing; the poll (if running) targets the new windows on its next tick.
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
    // The old window the cursor was on is gone; re-resolve it on the next poll tick.
    this.cursorDisplayId = null;
    if (!this.followingSuspended) {
      this.showAllInactive();
    }
  };

  /** Shows every window without activating it, so the user's focused app is never disturbed. */
  private showAllInactive(): void {
    for (const entry of this.entries) {
      if (!entry.window.isDestroyed() && !entry.window.isVisible()) {
        entry.window.showInactive();
      }
    }
  }

  /** Starts the cursor-follow poll if it isn't already running. */
  private startCursorFollow(): void {
    if (this.cursorFollowTimer !== null || this.destroyed) {
      return;
    }
    this.cursorFollowTimer = setInterval(this.pollCursorPosition, CURSOR_FOLLOW_POLL_INTERVAL_MS);
  }

  /** Stops the cursor-follow poll if it is running. */
  private stopCursorFollow(): void {
    if (this.cursorFollowTimer !== null) {
      clearInterval(this.cursorFollowTimer);
      this.cursorFollowTimer = null;
    }
  }

  // One poll tick: find the display under the cursor, tell the window it left (if any) to
  // stop drawing the following buddy, and stream the cursor's window-local position to
  // the window it is now on so the buddy tracks it. Screen coordinates and display bounds
  // are both in logical (DIP) pixels, matching the renderer's CSS-pixel coordinate space,
  // so the local point maps straight to on-screen position with no scaling.
  private pollCursorPosition = (): void => {
    if (this.destroyed || this.entries.length === 0) {
      return;
    }
    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    if (this.cursorDisplayId !== null && this.cursorDisplayId !== display.id) {
      this.sendRawToDisplay(this.cursorDisplayId, { type: "cursor-leave" });
    }
    this.cursorDisplayId = display.id;
    this.sendRawToDisplay(display.id, {
      type: "cursor-move",
      position: {
        localX: cursorPoint.x - display.bounds.x,
        localY: cursorPoint.y - display.bounds.y,
      },
    });
  };

  /**
   * Sends one event to a window without forcing it visible (the follow poll must never
   * un-hide a window during a capture; visibility is owned by suspend/resume + rebuild).
   */
  private sendRawToDisplay(displayId: number, event: OverlayEvent): void {
    const entry = this.entries.find((candidate) => candidate.displayId === displayId);
    if (!entry || entry.window.isDestroyed() || !entry.window.isVisible()) {
      return;
    }
    entry.window.webContents.send(OVERLAY_EVENT_CHANNEL, event);
  }

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
      // Fully transparent backing from the first frame, so macOS never paints its
      // default opaque fill before the window is first composited (same pale-border
      // artifact the Pill would otherwise show).
      backgroundColor: "#00000000",
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
