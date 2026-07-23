import { readFileSync, watch } from "node:fs";
import { app, BrowserWindow, ipcMain, systemPreferences, type WebContents } from "electron";
import {
  createReasoningCapability,
  describeCore,
  RoutingConfigStore,
  screenAwareChatRequest,
  type ReasoningVendorId,
  type ScreenCaptureInput,
} from "@lune/core";
import {
  CHAT_EVENT_CHANNEL,
  CHAT_START_CHANNEL,
  ChatStreamEventSchema,
  ChatTurnRequestSchema,
  LUNE_IPC_VERSION,
  type ChatStreamEvent,
} from "@lune/shared";
import { APP_QUIT_CHANNEL } from "../ipc/pillControl";
import {
  SCREEN_PERMISSION_REQUEST_CHANNEL,
  SCREEN_PERMISSION_STATUS_CHANNEL,
  SCREEN_RELAUNCH_CHANNEL,
} from "../ipc/screenPermission";
import { captureConnectedDisplays, nativeImageDownscale, screenCaptureProducesContent } from "./screenCapture/captureDisplays";
import {
  deriveScreenPermissionState,
  type ScreenRecordingAccessStatus,
} from "./screenCapture/screenPermissionState";
import { createPillWindow } from "./pillWindow";

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

// The Core is credentials-gated and transport-agnostic: the main process injects the
// platform `fetch`, the per-Vendor keys, and the screenshot downscale. Screen capture
// (ticket 05) now wires the real `nativeImage`-backed downscale, so the pipeline's
// coordinate remap runs against a genuine scale factor. An empty or absent key for the
// routed Vendor leaves the Capability gated off, surfacing as a terminal `error` event
// rather than an upstream call.
const reasoningCapability = createReasoningCapability({
  getRoutingConfig: () => routingConfigStore.getConfig(),
  getApiKey: (vendorId) => process.env[API_KEY_ENV_BY_VENDOR[vendorId]],
  upstreamFetch: (url, requestInit) => fetch(url, requestInit),
  downscaleScreenshot: nativeImageDownscale,
});

/**
 * This app's macOS Screen Recording access, as the OS reports it. Off macOS, screen
 * capture is ungated, so it is always granted (keeping the M7 Windows port a no-op here).
 */
function getScreenMediaAccessStatus(): ScreenRecordingAccessStatus {
  if (process.platform !== "darwin") {
    return "granted";
  }
  return systemPreferences.getMediaAccessStatus("screen") as ScreenRecordingAccessStatus;
}

// The last real capture probe's result: `true`/`false` once probed this run, `null`
// before then. It is what tells the granted-but-needs-relaunch case apart from a
// genuinely-working grant (macOS withholds frames from a pre-grant process).
let lastCaptureProducedContent: boolean | null = null;

/**
 * Captures the screen(s) for one turn, or returns nothing so the turn falls back to
 * text-only. Capture is attempted only when the turn opted in AND access is granted;
 * a capture failure never fails the turn (the user still gets an answer, just without
 * screen context). The screenshots stay in the main process - handed straight to the
 * in-process Core, never sent to the renderer, never written to disk (ticket 05).
 */
async function captureScreensForTurn(includeScreen: boolean): Promise<ScreenCaptureInput[]> {
  if (!includeScreen || getScreenMediaAccessStatus() !== "granted") {
    return [];
  }
  try {
    return await captureConnectedDisplays();
  } catch (error) {
    console.error("[lune] screen capture failed; answering text-only:", error);
    return [];
  }
}

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
  const { turnId, prompt, includeScreen } = parsedRequest.data;
  const webContents = event.sender;

  void (async () => {
    sendChatEvent(webContents, { type: "started", turnId, ipcVersion: LUNE_IPC_VERSION });
    try {
      // Capture the screen(s) first (when opted in and permitted) so the answer is
      // screen-aware; with no captures this is exactly a text-only turn.
      const screens = await captureScreensForTurn(includeScreen);
      for await (const chatEvent of reasoningCapability.streamChat(screenAwareChatRequest(prompt, screens))) {
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

// Quit from the pill menu tears the whole app down (developer story 41). Registered
// at app scope because quitting is not tied to any one window; the whisper child
// process teardown will hook into this same path when that Capability lands.
ipcMain.on(APP_QUIT_CHANNEL, () => app.quit());

// Screen-recording permission (ticket 05). The status channel reports the current
// state for live polling and never prompts when access is undetermined; when access
// is already granted it probes a real capture (which cannot prompt) so the UI learns
// the needs-relaunch case. The request channel actively probes - triggering the macOS
// prompt on the first attempt - so an explicit "grant" gesture drives the system flow.
ipcMain.handle(SCREEN_PERMISSION_STATUS_CHANNEL, async () => {
  const mediaAccessStatus = getScreenMediaAccessStatus();
  if (mediaAccessStatus === "granted") {
    lastCaptureProducedContent = await screenCaptureProducesContent().catch(() => lastCaptureProducedContent);
  }
  return deriveScreenPermissionState({ mediaAccessStatus, captureProducedContent: lastCaptureProducedContent });
});

ipcMain.handle(SCREEN_PERMISSION_REQUEST_CHANNEL, async () => {
  lastCaptureProducedContent = await screenCaptureProducesContent().catch(() => false);
  return deriveScreenPermissionState({
    mediaAccessStatus: getScreenMediaAccessStatus(),
    captureProducedContent: lastCaptureProducedContent,
  });
});

// macOS only hands screen frames to a process launched after the grant, so a
// freshly-granted app relaunches itself to start capturing (the relaunch-if-needed case).
ipcMain.on(SCREEN_RELAUNCH_CHANNEL, () => {
  app.relaunch();
  app.quit();
});

void app.whenReady().then(() => {
  console.log(`[lune] main process ready with ${describeCore()}`);

  // Lune is a background companion: no dock icon, no app-switcher entry (developer
  // story 40). Hiding the dock also makes the app an accessory, so its always-on-top
  // pill can float over full-screen apps without stealing the active Space.
  app.dock?.hide();

  createPillWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPillWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Lune runs as a background companion and is quit deliberately from the pill menu,
  // not by closing a window. The frameless pill has no close affordance, so this
  // path is only reached off-macOS (or in teardown), where quitting is correct.
  if (process.platform !== "darwin") {
    app.quit();
  }
});
