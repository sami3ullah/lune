import { readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, ipcMain, safeStorage, screen, systemPreferences, type WebContents } from "electron";
import {
  createConversationManager,
  createReasoningCapability,
  describeCore,
  parseAnswerPointTag,
  PROVISIONING_MANIFEST,
  RoutingConfigStore,
  type ReasoningVendorId,
  type SpeechCapability,
} from "@lune/core";
import {
  CHAT_EVENT_CHANNEL,
  CHAT_START_CHANNEL,
  ChatTurnRequestSchema,
  ConversationStreamEventSchema,
  LUNE_IPC_VERSION,
  type ConversationStreamEvent,
} from "@lune/shared";
import { APP_QUIT_CHANNEL } from "../ipc/pillControl";
import { CHAT_PANEL_TOGGLE_CHANNEL } from "../ipc/chatPanel";
import {
  CONVERSATIONS_CHANGED_CHANNEL,
  CONVERSATIONS_LIST_CHANNEL,
  CONVERSATIONS_NEW_CHANNEL,
  CONVERSATIONS_RESUME_CHANNEL,
  ConversationListSnapshotSchema,
  ResumedConversationSchema,
} from "../ipc/conversations";
import { ConversationHistoryStore } from "./conversationHistoryStore";
import { toggleChatPanelWindow } from "./chatPanelWindow";
import { toggleSettingsWindow } from "./settingsWindow";
import {
  SETTINGS_GET_CHANNEL,
  SETTINGS_READINESS_CHANNEL,
  SETTINGS_REPAIR_CHANNEL,
  SETTINGS_SAVE_CHANNEL,
  SETTINGS_SET_KEY_CHANNEL,
  SETTINGS_TOGGLE_CHANNEL,
  ReadinessRowSchema,
  SetApiKeyRequestSchema,
  SettingsSnapshotSchema,
  SettingsStateSchema,
  SettingsValuesSchema,
} from "../ipc/settings";
import { SettingsStore } from "./settings/settingsStore";
import { CredentialStore } from "./settings/credentialStore";
import { createSettingsService, type SettingsService } from "./settings/settingsService";
import {
  SCREEN_PERMISSION_REQUEST_CHANNEL,
  SCREEN_PERMISSION_STATUS_CHANNEL,
  SCREEN_RELAUNCH_CHANNEL,
} from "../ipc/screenPermission";
import {
  captureConnectedDisplays,
  nativeImageDownscale,
  screenCaptureProducesContent,
  type DisplayCaptureResult,
} from "./screenCapture/captureDisplays";
import { OverlayWindowManager } from "./overlay/overlayWindows";
import { planCompletionMessages } from "./overlay/overlayPointing";
import {
  deriveScreenPermissionState,
  type ScreenRecordingAccessStatus,
} from "./screenCapture/screenPermissionState";
import { createPillWindow } from "./pillWindow";
import { createDesktopProvisioning, runProvisioningDevTrigger } from "./provisioning/provisioningService";
import { resolveModelsDirectory } from "./provisioning/nodeGateways";
import {
  createDesktopTranscription,
  runTranscriptionDevTrigger,
  type DesktopTranscription,
} from "./transcription/transcriptionService";
import { createDesktopSpeech, runSpeechDevTrigger } from "./speech/speechService";
import { createSpeechTurnPlayer, type SpeechTurnPlayer } from "./speech/speechTurnPlayer";
import { SPEECH_EVENT_CHANNEL, SpeechEventSchema, type SpeechEvent } from "../ipc/speechPlayback";

// The Electron main process is the only place the in-process Core is imported; it
// bridges the Core's plain typed functions/streams to the renderer over typed IPC
// (Implementation Decisions). Ticket 03 wires the full cloud Reasoning core: the
// three Vendors behind the Vendor table, selected by the routing config and gated
// on per-Vendor keys. Ticket 13 wires Settings: the config file the Shell now writes,
// and the OS-encrypted key store the routed Vendor's key comes from.

/**
 * The dev-only env fallback for each Vendor's API key, used when no key is stored in
 * the OS-encrypted CredentialStore yet (so a `LUNE_*_API_KEY` still works in dev).
 */
const API_KEY_ENV_BY_VENDOR: Record<ReasoningVendorId, string> = {
  anthropic: "LUNE_ANTHROPIC_API_KEY",
  openai: "LUNE_OPENAI_API_KEY",
  google: "LUNE_GEMINI_API_KEY",
};

// The one config file the Shell writes and the Core reads (ticket 13). It defaults to
// config.json under the app's userData so Settings always has a real place to persist -
// a returning user's Vendor/Model/Voice/hotkey/streaming choices survive restarts;
// LUNE_CONFIG_PATH overrides it for dev/tests.
const routingConfigPath =
  process.env.LUNE_CONFIG_PATH !== undefined && process.env.LUNE_CONFIG_PATH.trim().length > 0
    ? process.env.LUNE_CONFIG_PATH
    : join(app.getPath("userData"), "config.json");

// The Shell-owned settings store over that file (reasoning/speech the Core reads, plus
// the Shell-only streaming-text toggle and push-to-talk hotkey), and the Core's
// read-only routing view of the same file. The Shell is the sole writer; after a save
// it reloads the Core store so the next turn routes to the new selection with no restart.
const settingsStore = new SettingsStore(
  routingConfigPath,
  (path) => readFileSync(path, "utf8"),
  (path, contents) => writeFileSync(path, contents, "utf8"),
);
const routingConfigStore = new RoutingConfigStore(routingConfigPath, (path) =>
  readFileSync(path, "utf8"),
);

// The Vendor API keys, in OS-encrypted storage (never the config file - the config
// holds no secrets). Constructing the store only reads the ciphertext file; the
// encrypt/decrypt calls run after the app is ready, on a key change or a chat turn. A
// stored key takes precedence over the dev env fallback.
const credentialStore = new CredentialStore(
  join(app.getPath("userData"), "credentials.json"),
  safeStorage,
  (path) => readFileSync(path, "utf8"),
  (path, contents) => writeFileSync(path, contents, "utf8"),
);

// Best-effort watch so a hand-edit of the config file reconciles routing without a
// restart. A save from Settings reloads the Core store explicitly (below), so this only
// covers external edits; a missing file (first run) simply has no watcher yet.
try {
  watch(routingConfigPath, () => {
    routingConfigStore.reload();
  });
} catch (error) {
  console.error("[lune] could not watch routing config file:", error);
}

// The Core is credentials-gated and transport-agnostic: the main process injects the
// platform `fetch`, the per-Vendor keys, and the screenshot downscale. Keys come from
// the OS-encrypted CredentialStore, falling back to the dev env var when none is stored
// yet. An empty or absent key for the routed Vendor leaves the Capability gated off,
// surfacing as a terminal `error` event rather than an upstream call.
const reasoningCapability = createReasoningCapability({
  getRoutingConfig: () => routingConfigStore.getConfig(),
  getApiKey: (vendorId) => credentialStore.getKey(vendorId) ?? process.env[API_KEY_ENV_BY_VENDOR[vendorId]],
  upstreamFetch: (url, requestInit) => fetch(url, requestInit),
  downscaleScreenshot: nativeImageDownscale,
});

// The Settings service (ticket 13): composes the config-file store, the OS-encrypted
// key store, and the Provisioning run into the snapshots the Settings window reads and
// the edits it applies. Assigned once the app is ready (it needs the Provisioning
// Capability); the Settings window opens only after the UI is up, so it is set before
// any Settings IPC fires. The repair action re-runs every pinned Runtime's download.
let settingsService: SettingsService | null = null;
const REPAIR_RUNTIME_IDS = PROVISIONING_MANIFEST.map((runtime) => runtime.id);

/** The Settings service once ready; a Settings IPC before then is a programmer error. */
function requireSettingsService(): SettingsService {
  if (settingsService === null) {
    throw new Error("Settings service is not ready yet");
  }
  return settingsService;
}

// Conversation state lives in the Core (ticket 06): the Chat Panel renders the history
// the manager owns. The manager holds one *active* conversation; the durable set of
// the last 10 (text only, oldest pruned) is the Shell's ConversationHistoryStore below.
const conversationManager = createConversationManager({
  reasoningCapability,
  generateMessageId: () => randomUUID(),
});

// The durable last-10 conversation store (ticket 12): text only, under the app's
// userData, oldest auto-pruned. Persistence is a platform concern, so it sits in the
// Shell behind an injected fs seam; the Core stays filesystem-agnostic. A missing file
// (first run) simply loads as empty history.
const conversationHistoryStore = new ConversationHistoryStore(
  join(app.getPath("userData"), "conversations.json"),
  (path) => readFileSync(path, "utf8"),
  (path, contents) => writeFileSync(path, contents, "utf8"),
  () => Date.now(),
);

// The active conversation the next turn belongs to. On boot we resume the most recent
// one so a restart lands the user back where they left off (and every stored one is in
// the dropdown); a first run starts a fresh, unpersisted conversation.
let activeConversationId: string = (() => {
  const mostRecent = conversationHistoryStore.list()[0];
  if (mostRecent) {
    const resumed = conversationHistoryStore.get(mostRecent.id);
    if (resumed) {
      conversationManager.loadConversation(resumed.messages);
      return mostRecent.id;
    }
  }
  return randomUUID();
})();

/**
 * Tells the Chat Panel its recent-conversations set changed (a turn created a new
 * conversation, firmed up a title, or pruned the oldest) so it re-reads the list. Sent
 * to the window that ran the turn - the only surface that starts turns is the panel.
 */
function notifyConversationsChanged(webContents: WebContents): void {
  if (!webContents.isDestroyed()) {
    webContents.send(CONVERSATIONS_CHANGED_CHANNEL);
  }
}

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

// The Overlay windows (ticket 07): the playful cursor + response bubble surface, one
// click-through window per display. Assigned once the app is ready (it creates
// windows); a chat turn only runs after the UI is up, so it is always set by then.
let overlayManager: OverlayWindowManager | null = null;

// The Transcription lifecycle (ticket 10): the supervised whisper.cpp child + its Core
// Capability. Held at module scope so app-quit and abrupt-exit teardown can reach it to
// stop the child (developer story 41 - quitting orphans nothing). Assigned once the app
// is ready and Provisioning readiness is known.
let transcription: DesktopTranscription | null = null;

// The Speech Capability (ticket 09): on-device Kokoro synthesis, gated on the Kokoro
// weights being provisioned. Assigned once the app is ready (it needs the Provisioning
// readiness + models directory). A chat turn only runs after the UI is up, so it is set
// by then; when Kokoro isn't ready the turn simply answers in text without speaking.
let speechCapability: SpeechCapability | null = null;

// The Pill window: Lune's always-present home surface, and the one renderer that owns
// audio output, so synthesized speech clips are streamed to it. Assigned when the app
// creates the Pill.
let pillWindow: BrowserWindow | null = null;

/**
 * Sends one Kokoro speech-playback event to the Pill renderer (which owns audio
 * output), validating it against the shared codec on the way out so no untyped shape
 * crosses the boundary (developer story 46). A no-op if the Pill is gone.
 */
function sendSpeechEvent(event: SpeechEvent): void {
  if (pillWindow === null || pillWindow.isDestroyed()) {
    return;
  }
  pillWindow.webContents.send(SPEECH_EVENT_CHANNEL, SpeechEventSchema.parse(event));
}

/**
 * Captures the screen(s) for one turn, or returns nothing so the turn falls back to
 * text-only. Capture is attempted only when the turn opted in AND access is granted;
 * a capture failure never fails the turn (the user still gets an answer, just without
 * screen context). The screenshots stay in the main process - handed straight to the
 * in-process Core, never sent to the renderer, never written to disk (ticket 05).
 */
async function captureScreensForTurn(includeScreen: boolean): Promise<DisplayCaptureResult> {
  if (!includeScreen || getScreenMediaAccessStatus() !== "granted") {
    return { screens: [], geometry: [] };
  }
  try {
    return await captureConnectedDisplays();
  } catch (error) {
    console.error("[lune] screen capture failed; answering text-only:", error);
    return { screens: [], geometry: [] };
  }
}

/**
 * Sends one streamed conversation event to the renderer, validating it against the
 * shared contract on the way out so no untyped shape ever crosses the boundary
 * (developer story 46). A dead/closed WebContents (window gone mid-stream) is skipped.
 */
function sendConversationEvent(webContents: WebContents, event: ConversationStreamEvent): void {
  if (webContents.isDestroyed()) {
    return;
  }
  // Parse (not just assert) on the way out so the event the renderer receives is
  // exactly the validated shape - a drift in the Core's event mapping fails loudly
  // here rather than as a confusing shape error in the renderer.
  webContents.send(CHAT_EVENT_CHANNEL, ConversationStreamEventSchema.parse(event));
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

// Drive one conversation turn: validate the request, capture screen context, advance
// the Core conversation, and stream its events to the renderer tagged with the turn
// id. A thrown Core error (not ready, Vendor rejection) becomes a terminal `error`
// event so the renderer never hangs waiting for a completion that will not come.
ipcMain.on(CHAT_START_CHANNEL, (event, rawChatTurnRequest: unknown) => {
  const parsedRequest = ChatTurnRequestSchema.safeParse(rawChatTurnRequest);
  if (!parsedRequest.success) {
    // A malformed start request has no usable turn id to correlate against, so it
    // is dropped rather than answered - the renderer only ever sends valid requests.
    console.error("[lune] dropping malformed chat start request:", parsedRequest.error.message);
    return;
  }
  const { turnId, prompt, inputMethod, includeScreen } = parsedRequest.data;
  const webContents = event.sender;

  void (async () => {
    sendConversationEvent(webContents, { type: "started", turnId, ipcVersion: LUNE_IPC_VERSION });

    // Hide any lingering Overlay before capturing so it can never photograph its own
    // cursor/bubble into this turn's screen context.
    overlayManager?.hideAll();

    // Overlay driving state for this turn (ticket 07): the answer bubble + cursor run on
    // the display holding the user's cursor (screen 1, the model's primary focus). We
    // stream the answer with its trailing Point Tag stripped, then point once the tag is
    // complete. `sentCleanLength` tracks how much clean text the Overlay already has.
    let overlayActive = false;
    let accumulatedAnswer = "";
    let sentCleanLength = 0;
    // The Overlay display for this turn - hoisted so the catch below can end the
    // interaction it may have started. Resolved once the screens are captured.
    let cursorDisplayId: number | undefined;
    // Kokoro speech for this turn (ticket 09): created only when Speech is ready, so a
    // not-ready Kokoro answers in text without speaking (and without hanging). It
    // sentence-streams the answer to the Pill's audio output as the reply arrives.
    let speechTurn: SpeechTurnPlayer | null = null;

    // The streaming-text toggle (ticket 13): read once at the turn's start so a change
    // takes effect on the next turn. When off, the Overlay cursor still flies and points,
    // but the answer text is not streamed into its response bubble (voice-only preference).
    const showStreamingText = settingsStore.getStreamingText();

    try {
      // Capture the screen(s) first (when opted in and permitted) so the answer is
      // screen-aware; with no captures this is exactly a text-only turn (and no pointing).
      const { screens, geometry } = await captureScreensForTurn(includeScreen);

      // Where the Overlay bubble/cursor lives: the cursor's display (screen 1 in the
      // capture geometry), falling back to whatever display the cursor is on now for a
      // text-only turn that captured nothing.
      cursorDisplayId =
        geometry.find((display) => display.screenNumber === 1)?.displayId ??
        overlayManager?.displayIdAt(screen.getCursorScreenPoint());

      for await (const coreEvent of conversationManager.submitUserTurn({
        text: prompt,
        inputMethod,
        screenshots: screens,
      })) {
        switch (coreEvent.type) {
          case "user-message":
            sendConversationEvent(webContents, {
              type: "user-message",
              turnId,
              messageId: coreEvent.message.id,
              text: coreEvent.message.text,
              inputMethod: coreEvent.message.inputMethod,
            });
            break;
          case "assistant-started":
            sendConversationEvent(webContents, {
              type: "assistant-started",
              turnId,
              messageId: coreEvent.messageId,
            });
            // Fade the Overlay in for this interaction on the cursor's display.
            if (overlayManager && cursorDisplayId !== undefined) {
              overlayManager.sendToDisplay(cursorDisplayId, { type: "activity-start" });
              overlayActive = true;
            }
            // Begin sentence-streamed speech only when Kokoro is provisioned; otherwise
            // the turn answers in text without speaking (never a hang).
            if (speechCapability?.isReady()) {
              speechTurn = createSpeechTurnPlayer({
                speech: speechCapability,
                turnId,
                sendEvent: sendSpeechEvent,
                encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
              });
            }
            break;
          case "assistant-delta":
            sendConversationEvent(webContents, {
              type: "assistant-delta",
              turnId,
              messageId: coreEvent.messageId,
              text: coreEvent.text,
            });
            accumulatedAnswer += coreEvent.text;
            // Sentence-stream the growing answer to Kokoro: each completed sentence is
            // synthesized and played while the next is still arriving (first audio fast).
            speechTurn?.pushAnswerText(accumulatedAnswer);
            // Stream the answer into the Overlay bubble, but only the clean human text:
            // parse the accumulated answer and emit just the newly-revealed display
            // characters, so the trailing `[POINT:...]` tag never appears in the bubble.
            // Gated on the streaming-text toggle: when off, no bubble text is sent.
            if (overlayManager && cursorDisplayId !== undefined && showStreamingText) {
              const { displayText } = parseAnswerPointTag(accumulatedAnswer);
              if (displayText.length > sentCleanLength) {
                overlayManager.sendToDisplay(cursorDisplayId, {
                  type: "answer-delta",
                  text: displayText.slice(sentCleanLength),
                });
                sentCleanLength = displayText.length;
              }
            }
            break;
          case "assistant-completed": {
            sendConversationEvent(webContents, {
              type: "assistant-completed",
              turnId,
              messageId: coreEvent.messageId,
            });
            if (overlayManager && cursorDisplayId !== undefined) {
              // The full answer has streamed, so its trailing Point Tag (if any) is now
              // complete. The planner turns the parsed directive + capture geometry into
              // the exact messages to send (fly to the target on the correct monitor,
              // then close out), keeping the multi-monitor sequencing in one tested place.
              const { directive } = parseAnswerPointTag(accumulatedAnswer);
              for (const message of planCompletionMessages(directive, geometry, cursorDisplayId)) {
                overlayManager.sendToDisplay(message.displayId, message.event);
              }
            }
            // Flush the final (unterminated) sentence and let speech drain. The first
            // audio already started mid-stream; a not-ready turn has no speechTurn and
            // simply stayed silent.
            await speechTurn?.finish(accumulatedAnswer);
            break;
          }
        }
      }

      // The turn committed in the Core, so persist the active conversation's text-only
      // history (ticket 12) - creating it on the first turn, updating it after, pruning
      // the oldest beyond 10 - and tell the panel its recent-list may have changed. A
      // failed turn throws above and never reaches here, matching the Core's rollback.
      conversationHistoryStore.save(activeConversationId, conversationManager.getMessages());
      notifyConversationsChanged(webContents);
    } catch (error) {
      sendConversationEvent(webContents, { type: "error", turnId, message: describeChatError(error) });
      // End any Overlay interaction this turn opened so the cursor fades out rather
      // than hanging on screen after a failed answer.
      if (overlayManager && overlayActive && cursorDisplayId !== undefined) {
        overlayManager.sendToDisplay(cursorDisplayId, { type: "activity-end" });
      }
      // Stop any speech this turn had queued or was playing so a failed answer doesn't
      // keep talking (and the Pill returns to idle).
      if (speechTurn !== null) {
        sendSpeechEvent({ type: "stop" });
      }
    }
  })();
});

// Open/close the Chat Panel from the Pill menu (or its own close button). One toggle
// keeps both entry points in agreement.
ipcMain.on(CHAT_PANEL_TOGGLE_CHANNEL, () => toggleChatPanelWindow());

// Open/close the Settings window from the Pill menu (ticket 13).
ipcMain.on(SETTINGS_TOGGLE_CHANNEL, () => toggleSettingsWindow());

// The Settings surface's request/response IPC (ticket 13): read the current snapshot,
// persist edited Vendor/Model/Voice/hotkey/streaming values, set/clear a Vendor's API
// key in OS-encrypted storage, re-run/repair Provisioning, and poll live readiness.
// Every payload is validated on the way in and every reply parsed on the way out, so no
// untyped shape crosses the boundary (developer story 46).
ipcMain.handle(SETTINGS_GET_CHANNEL, () => SettingsSnapshotSchema.parse(requireSettingsService().snapshot()));
ipcMain.handle(SETTINGS_SAVE_CHANNEL, (_event, rawValues: unknown) => {
  const values = SettingsValuesSchema.parse(rawValues);
  return SettingsStateSchema.parse(requireSettingsService().save(values));
});
ipcMain.handle(SETTINGS_SET_KEY_CHANNEL, (_event, rawRequest: unknown) => {
  const request = SetApiKeyRequestSchema.parse(rawRequest);
  return SettingsStateSchema.parse(requireSettingsService().setKey(request));
});
ipcMain.handle(SETTINGS_REPAIR_CHANNEL, () => SettingsStateSchema.parse(requireSettingsService().repair()));
ipcMain.handle(SETTINGS_READINESS_CHANNEL, () =>
  ReadinessRowSchema.array().parse(requireSettingsService().readiness()),
);

// The recent-conversations dropdown (ticket 12). These drive the Shell's durable store
// and the Core's active conversation; the answer stream still flows over the shared
// chat contract. Each result is parsed on the way out so no untyped shape crosses the
// boundary (developer story 46).

// The dropdown's list + which conversation is active. A fresh, not-yet-persisted
// conversation reports a `null` active id, so the panel shows "New conversation" rather
// than selecting a row that is not in the list yet.
ipcMain.handle(CONVERSATIONS_LIST_CHANNEL, () =>
  ConversationListSnapshotSchema.parse({
    conversations: conversationHistoryStore.list(),
    activeId: conversationHistoryStore.get(activeConversationId) ? activeConversationId : null,
  }),
);

// Resume a stored conversation: seed the Core with its prior text history and make it
// active, then return that history for the panel to render. An unknown id leaves the
// current conversation active (the renderer only ever sends ids from the live list).
// The resumed turn answers with fresh screen context - screenshots were never stored.
ipcMain.handle(CONVERSATIONS_RESUME_CHANNEL, (_event, rawId: unknown) => {
  if (typeof rawId === "string") {
    const resumed = conversationHistoryStore.get(rawId);
    if (resumed) {
      conversationManager.loadConversation(resumed.messages);
      activeConversationId = rawId;
    }
  }
  return ResumedConversationSchema.parse({
    activeId: activeConversationId,
    messages: conversationManager.getMessages(),
  });
});

// Start a new, empty conversation: reset the Core's active history and mint a fresh id
// (persisted only once its first turn completes). Returns the new active id.
ipcMain.handle(CONVERSATIONS_NEW_CHANNEL, () => {
  activeConversationId = randomUUID();
  conversationManager.loadConversation([]);
  return activeConversationId;
});

// Quit from the pill menu tears the whole app down (developer story 41). Registered
// at app scope because quitting is not tied to any one window. The whisper child
// process is torn down via the `before-quit`/`exit` handlers below, so quitting
// leaves nothing orphaned (ticket 10 acceptance).
ipcMain.on(APP_QUIT_CHANNEL, () => app.quit());

// Whisper child-process teardown (ticket 10, developer story 41). `before-quit` runs
// on the normal quit path (pill menu, relaunch) and issues a SIGTERM via the
// supervisor. `exit` is the abrupt-exit net (uncaught error, hard exit) where only
// synchronous work runs, so it SIGKILLs the child directly - between them, a quit or
// crash never leaves a whisper-server process behind. (A parent SIGKILL can't be
// intercepted by anyone, but there is no owning watchdog process to route around it.)
app.on("before-quit", () => {
  void transcription?.shutdown();
});
process.on("exit", () => {
  transcription?.killSync();
});

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

  // Keep the Pill handle: it is the renderer that plays Kokoro speech clips (ticket 09).
  pillWindow = createPillWindow();

  // The Overlay (ticket 07): one click-through, focus-less window per display, hosting
  // the playful cursor + response bubble. Created hidden and shown only during a chat
  // turn (driven above); it rebuilds itself when displays are added/removed/rearranged.
  overlayManager = new OverlayWindowManager();
  overlayManager.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPillWindow();
    }
  });

  // Provisioning (ticket 08): the background model-download subsystem, wired to the
  // real Node gateways and rooted at the one Lune-managed models directory under the
  // app's userData. `refreshReadiness` runs at boot so already-downloaded weights
  // report ready immediately; the env-gated dev trigger (LUNE_PROVISION_ON_START)
  // downloads the real weights with visible console progress before the onboarding UI
  // exists (ticket 14). A normal launch never starts a download.
  const provisioning = createDesktopProvisioning(resolveModelsDirectory(app.getPath("userData")));

  // Transcription (ticket 10): on-device whisper.cpp batch STT. The Core owns the
  // supervision + readiness + transcribe logic; this injects the whisper-server edge
  // and drives the lifecycle. Whisper is ready only when its weights are provisioned
  // AND its child Runtime is healthy; the binary comes from a pinned-source build
  // pointed at by LUNE_WHISPER_SERVER_PATH (absent in dev → whisper reports not-ready).
  transcription = createDesktopTranscription({
    modelsDirectoryPath: provisioning.modelsDirectoryPath,
    isWhisperProvisioned: () => provisioning.capability.isRuntimeReady("whisper"),
  });

  // Speech (ticket 09): the in-process Kokoro engine, gated on the Kokoro weights being
  // provisioned + verified (read live, so readiness flips automatically when a download
  // completes - no rebuild). The Voice comes from the routing config.
  speechCapability = createDesktopSpeech({
    modelsDirectoryPath: provisioning.modelsDirectoryPath,
    getRoutingConfig: () => routingConfigStore.getConfig(),
    isKokoroReady: () => provisioning.capability.isRuntimeReady("kokoro"),
  });

  // Settings (ticket 13): now that Provisioning exists, wire the service the Settings
  // IPC handlers call. Readiness reads the Provisioning run's live status + per-Runtime
  // verified state; Repair re-downloads every pinned Runtime, then reconciles the
  // whisper child once the run settles so a repaired Transcription comes back healthy.
  settingsService = createSettingsService({
    settingsStore,
    credentialStore,
    provisioningStatus: () => provisioning.capability.status(),
    isRuntimeReady: (runtimeId) => provisioning.capability.isRuntimeReady(runtimeId),
    startRepair: () => {
      provisioning.capability.start(REPAIR_RUNTIME_IDS);
      void provisioning.capability.awaitCurrentRun().then(() => transcription?.reconcile());
    },
    reloadRouting: () => {
      routingConfigStore.reload();
    },
  });

  // Refresh Provisioning readiness (and optionally run the ~2 GB dev download), then
  // start the whisper child if it can run, and finally exercise the Core transcribe
  // API on the env-gated dev WAV (ticket 10 acceptance #1). Each step is a no-op on a
  // normal launch, so this is safe to run unconditionally at boot.
  void (async () => {
    await runProvisioningDevTrigger(provisioning);
    await transcription!.reconcile();
    await runTranscriptionDevTrigger(transcription!);
    // Exercise the Kokoro native edges (onnxruntime-node + espeak) in dev once the
    // weights are provisioned (ticket 09 acceptance #3); a no-op on a normal launch.
    await runSpeechDevTrigger(speechCapability!);
  })().catch((error) => {
    console.error("[lune] provisioning/transcription/speech boot failed:", error);
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
