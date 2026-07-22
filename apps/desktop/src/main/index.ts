import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { describeCore, handlePing } from "@lune/core";
import { PING_IPC_CHANNEL, PingRequestSchema } from "@lune/shared";

// The Electron main process is the only place the in-process Core is imported;
// it bridges the Core's plain typed functions to the renderer over typed IPC
// (Implementation Decisions). This scaffold wires a single placeholder round-trip;
// the real Capability bridges arrive in later tickets.
ipcMain.handle(PING_IPC_CHANNEL, (_event, rawPingRequest: unknown) => {
  const pingRequest = PingRequestSchema.parse(rawPingRequest);
  return handlePing(pingRequest);
});

function createPlaceholderWindow(): BrowserWindow {
  // A plain window stands in for the Pill during the scaffold. The real
  // always-on-top, draggable, hover-expanding Pill is built in a later ticket.
  const placeholderWindow = new BrowserWindow({
    width: 460,
    height: 360,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  placeholderWindow.on("ready-to-show", () => placeholderWindow.show());

  // In development electron-vite serves the renderer and exposes its URL here;
  // in a packaged build we load the built HTML from disk instead.
  if (process.env.ELECTRON_RENDERER_URL) {
    void placeholderWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void placeholderWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return placeholderWindow;
}

void app.whenReady().then(() => {
  console.log(`[lune] main process ready with ${describeCore()}`);
  createPlaceholderWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPlaceholderWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS apps usually stay alive without windows; Lune ultimately runs as a
  // background companion, but for the scaffold we quit on all-closed off-macOS.
  if (process.platform !== "darwin") {
    app.quit();
  }
});
