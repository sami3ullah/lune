import { join } from "node:path";
import { readFileSync, watch } from "node:fs";
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import {
  createReasoningCapability,
  describeCore,
  RoutingConfigStore,
  textOnlyChatRequest,
  type DownscaleScreenshot,
  type ReasoningVendorId,
} from "@lune/core";
import {
  CHAT_EVENT_CHANNEL,
  CHAT_START_CHANNEL,
  ChatStreamEventSchema,
  ChatTurnRequestSchema,
  LUNE_IPC_VERSION,
  type ChatStreamEvent,
} from "@lune/shared";

// The Electron main process is the only place the in-process Core is imported; it
// bridges the Core's plain typed functions/streams to the renderer over typed IPC
// (Implementation Decisions). Ticket 03 wires the full cloud Reasoning core: the
// three Vendors behind the Vendor table, selected by the routing config and gated
// on per-Vendor keys. Screen capture, the OS keychain, and the config-writing
// Settings UI arrive in later tickets; until then the config path and keys come
// from the environment and no screenshots flow over IPC yet.

/** The environment variable carrying each Vendor's API key (keychain comes later). */
const API_KEY_ENV_BY_VENDOR: Record<ReasoningVendorId, string> = {
  anthropic: "LUNE_ANTHROPIC_API_KEY",
  openai: "LUNE_OPENAI_API_KEY",
  google: "LUNE_GEMINI_API_KEY",
};

// The live routing config: which Vendor + Model Slot answers. It is read from the
// file the Shell writes (once Settings exists); before then, the store falls back
// to the Gemini-default config. Watching the file lets a Setting the user edits
// reconcile routing with no restart.
const routingConfigPath = process.env.LUNE_CONFIG_PATH;
const routingConfigStore = new RoutingConfigStore(routingConfigPath, (path) =>
  readFileSync(path, "utf8"),
);

if (routingConfigPath !== undefined && routingConfigPath.trim().length > 0) {
  try {
    watch(routingConfigPath, () => {
      routingConfigStore.reload();
    });
  } catch (error) {
    // A missing file (not yet written) is fine - the store already holds the
    // defaults, and the watcher is best-effort until the Shell writes the file.
    console.error("[lune] could not watch routing config file:", error);
  }
}

// Screenshots do not yet cross the IPC boundary (screen capture is a later ticket),
// so nothing is ever downscaled today. The passthrough keeps the pipeline's remap at
// the identity; the real pixel-resizing edge is wired when screen capture lands.
const passthroughDownscale: DownscaleScreenshot = async (screenshot) => ({
  ...screenshot,
  scaleFactor: 1,
});

// The Core is credentials-gated and transport-agnostic: the main process injects the
// platform `fetch`, the per-Vendor keys, and the (currently passthrough) downscale.
// An empty or absent key for the routed Vendor leaves the Capability gated off,
// surfacing as a terminal `error` event rather than an upstream call.
const reasoningCapability = createReasoningCapability({
  getRoutingConfig: () => routingConfigStore.getConfig(),
  getApiKey: (vendorId) => process.env[API_KEY_ENV_BY_VENDOR[vendorId]],
  upstreamFetch: (url, requestInit) => fetch(url, requestInit),
  downscaleScreenshot: passthroughDownscale,
});

/**
 * Sends one streamed chat event to the renderer, validating it against the shared
 * contract on the way out so no untyped shape ever crosses the boundary (developer
 * story 46). A dead/closed WebContents (window gone mid-stream) is skipped silently.
 */
function sendChatEvent(webContents: WebContents, event: ChatStreamEvent): void {
  if (webContents.isDestroyed()) {
    return;
  }
  // Parse (not just assert) on the way out so the event the renderer receives is
  // exactly the validated shape - a drift in the Core's event mapping fails loudly
  // here rather than as a confusing shape error in the renderer.
  webContents.send(CHAT_EVENT_CHANNEL, ChatStreamEventSchema.parse(event));
}

/**
 * A human-readable, always-non-empty description of a thrown Core error. The
 * `error` event's `message` is contract-required to be non-empty, so falling back
 * here guarantees a terminal event always reaches the renderer - even for an odd
 * error with an empty message - rather than letting the panel hang.
 */
function describeChatError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return rawMessage.length > 0 ? rawMessage : "Chat request failed for an unknown reason";
}

// Drive one chat turn: validate the request, stream the Core's canonical events to
// the renderer tagged with the turn id, and translate a thrown Core error (not
// ready, Vendor rejection) into a terminal `error` event so the renderer never
// hangs waiting for a `done` that will not come.
ipcMain.on(CHAT_START_CHANNEL, (event, rawChatTurnRequest: unknown) => {
  const parsedRequest = ChatTurnRequestSchema.safeParse(rawChatTurnRequest);
  if (!parsedRequest.success) {
    // A malformed start request has no usable turn id to correlate against, so it
    // is dropped rather than answered - the renderer only ever sends valid requests.
    console.error("[lune] dropping malformed chat start request:", parsedRequest.error.message);
    return;
  }
  const { turnId, prompt } = parsedRequest.data;
  const webContents = event.sender;

  void (async () => {
    sendChatEvent(webContents, { type: "started", turnId, ipcVersion: LUNE_IPC_VERSION });
    try {
      for await (const chatEvent of reasoningCapability.streamChat(textOnlyChatRequest(prompt))) {
        switch (chatEvent.type) {
          case "text-delta":
            sendChatEvent(webContents, { type: "delta", turnId, text: chatEvent.text });
            break;
          case "done":
            sendChatEvent(webContents, { type: "done", turnId });
            break;
        }
      }
    } catch (error) {
      sendChatEvent(webContents, { type: "error", turnId, message: describeChatError(error) });
    }
  })();
});

function createPlaceholderWindow(): BrowserWindow {
  // A plain window stands in for the Pill during the skeleton. The real
  // always-on-top, draggable, hover-expanding Pill is built in a later ticket.
  const placeholderWindow = new BrowserWindow({
    width: 460,
    height: 420,
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
  // background companion, but for the skeleton we quit on all-closed off-macOS.
  if (process.platform !== "darwin") {
    app.quit();
  }
});
