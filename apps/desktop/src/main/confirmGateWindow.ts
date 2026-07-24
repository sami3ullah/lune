import { join } from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import {
  CONFIRM_GATE_ANSWER_CHANNEL,
  CONFIRM_GATE_EVENT_CHANNEL,
  CONFIRM_GATE_ROUTE_HASH,
  ConfirmGateAnswerSchema,
  type ConfirmGateAnswerValue,
  type ConfirmGateEvent,
  type ConfirmGateViewValue,
} from "../ipc/confirmGate";

/** One chip answer intent ("approve" | "cancel"), sourced from the IPC contract. */
type GateIntent = ConfirmGateAnswerValue["intent"];

// The Confirm Gate window (M2-04): the on-screen chip that asks the user to approve or
// decline before the Screen Agent touches the OS. Unlike the click-through Overlay, this
// window must *catch* clicks (its Approve/Cancel buttons are one of the three ways to
// answer a gate), so it is its own small, focusable, always-on-top window rather than a
// layer on the presentational Overlay.
//
// It is the untested OS-and-pixels edge; the decision logic behind it (reconciliation,
// explanation, the controller) is the tested core. The window stays hidden between gates
// and is shown - centered on the display under the cursor, so it appears where the user is
// working - only while a gate is open.

/** The chip's fixed size, in logical pixels; the content is laid out to fit within it. */
const GATE_WINDOW_SIZE = { width: 380, height: 200 };

/**
 * Owns the single Confirm Gate window and its answer channel. The controller drives it
 * through {@link open} / {@link close} and subscribes to button answers via
 * {@link onAnswer}; the hotkey and voice modalities are wired elsewhere.
 */
export class ConfirmGateWindow {
  private window: BrowserWindow | null = null;
  /** The current button-answer subscriber, or `null` when no gate is open. */
  private answerHandler: ((intent: GateIntent) => void) | null = null;

  constructor() {
    ipcMain.on(CONFIRM_GATE_ANSWER_CHANNEL, this.handleAnswer);
  }

  /**
   * Opens the gate on the display under the cursor, showing (and focusing, so its buttons
   * are immediately clickable) the chip with `view`. Lazily creates the window on first use.
   */
  open(view: ConfirmGateViewValue): void {
    const window = this.ensureWindow();
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = cursorDisplay.workArea;
    // Centered horizontally, a little above the vertical middle so it doesn't cover the
    // exact point Lune is about to act on.
    window.setBounds({
      x: Math.round(x + (width - GATE_WINDOW_SIZE.width) / 2),
      y: Math.round(y + (height - GATE_WINDOW_SIZE.height) / 3),
      width: GATE_WINDOW_SIZE.width,
      height: GATE_WINDOW_SIZE.height,
    });
    window.show();
    window.focus();
    this.send(window, { type: "open", view });
  }

  /** Hides the gate window (the run continues or ends per the answer). Safe if already hidden. */
  close(): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) {
      return;
    }
    this.send(window, { type: "close" });
    if (window.isVisible()) {
      window.hide();
    }
  }

  /**
   * Subscribes to the chip's Approve/Cancel button presses. Only one gate is open at a time,
   * so this replaces any prior handler. Returns an unsubscribe function.
   */
  onAnswer(handler: (intent: GateIntent) => void): () => void {
    this.answerHandler = handler;
    return () => {
      if (this.answerHandler === handler) {
        this.answerHandler = null;
      }
    };
  }

  /** Tears down the window and the answer channel. */
  dispose(): void {
    ipcMain.removeListener(CONFIRM_GATE_ANSWER_CHANNEL, this.handleAnswer);
    this.answerHandler = null;
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }

  private handleAnswer = (_event: Electron.IpcMainEvent, rawAnswer: unknown): void => {
    const parsed = ConfirmGateAnswerSchema.safeParse(rawAnswer);
    if (!parsed.success) {
      console.error("[lune] dropping malformed confirm-gate answer:", parsed.error.message);
      return;
    }
    this.answerHandler?.(parsed.data.intent);
  };

  private send(window: BrowserWindow, event: ConfirmGateEvent): void {
    if (!window.isDestroyed()) {
      window.webContents.send(CONFIRM_GATE_EVENT_CHANNEL, event);
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.window !== null && !this.window.isDestroyed()) {
      return this.window;
    }
    const window = new BrowserWindow({
      ...GATE_WINDOW_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: true,
      skipTaskbar: true,
      fullscreenable: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: false,
      },
    });

    // Float above ordinary and full-screen apps, on every Space, so the gate is seen and
    // answerable wherever the user is working.
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${CONFIRM_GATE_ROUTE_HASH}`);
    } else {
      void window.loadFile(join(__dirname, "../renderer/index.html"), {
        hash: CONFIRM_GATE_ROUTE_HASH,
      });
    }

    this.window = window;
    return window;
  }
}
