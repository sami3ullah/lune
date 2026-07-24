import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, screen, shell, systemPreferences, type WebContents } from "electron";
import {
  createAnthropicComputerUseAdapter,
  createConversationManager,
  createGeminiComputerUseAdapter,
  createOpenAiComputerUseAdapter,
  createReasoningCapability,
  createScreenAgentCapability,
  describeCore,
  findReasoningVendor,
  parseAnswerPointTag,
  PROVISIONING_MANIFEST,
  RoutingConfigStore,
  validateReasoningKey,
  type ComputerUseVendorId,
  type ReasoningVendorId,
  type SpeechCapability,
} from "@lune/core";
import {
  CHAT_EVENT_CHANNEL,
  CHAT_START_CHANNEL,
  ChatTurnRequestSchema,
  ConversationStreamEventSchema,
  LUNE_IPC_VERSION,
  type ChatInputMethod,
  type ConversationStreamEvent,
} from "@lune/shared";
import { APP_QUIT_CHANNEL, PILL_CAPTION_CHANNEL, PillCaptionSchema } from "../ipc/pillControl";
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
import { getChatPanelWebContents, toggleChatPanelWindow } from "./chatPanelWindow";
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
import { VENDOR_GET_KEY_URLS, SettingsVendorIdSchema } from "../ipc/settings";
import { SettingsStore } from "./settings/settingsStore";
import { CredentialStore } from "./settings/credentialStore";
import { createSettingsService, type SettingsService } from "./settings/settingsService";
import {
  ONBOARDING_COMPLETE_CHANNEL,
  ONBOARDING_DOWNLOAD_STATUS_CHANNEL,
  ONBOARDING_OPEN_GET_KEY_CHANNEL,
  ONBOARDING_START_DOWNLOAD_CHANNEL,
  ONBOARDING_VALIDATE_KEY_CHANNEL,
  OnboardingDownloadStatusSchema,
  ValidateKeyRequestSchema,
  ValidateKeyResponseSchema,
} from "../ipc/onboarding";
import { OnboardingStore } from "./onboarding/onboardingStore";
import { createOnboardingService, type OnboardingService } from "./onboarding/onboardingService";
import { closeOnboardingWindow, openOnboardingWindow } from "./onboardingWindow";
import {
  SCREEN_OPEN_SETTINGS_CHANNEL,
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
import {
  createDesktopSyntheticInputExecutor,
  runSyntheticInputDevTrigger,
} from "./agent/syntheticInputService";
import type { SyntheticInputExecutor } from "./agent/syntheticInputExecutor";
import {
  createScreenAgentService,
  runScreenAgentDevTrigger,
  type ScreenAgentService,
} from "./agent/screenAgentService";
import { createConfirmGateController } from "./agent/confirmGateController";
import { ConfirmGateWindow } from "./confirmGateWindow";
import {
  resolveWhisperServerBinaryPath,
  WHISPER_SERVER_PATH_ENV,
  WHISPER_SERVER_RESOURCE_NAME,
} from "./transcription/whisperServerBinaryPath";
import { createDesktopSpeech, runSpeechDevTrigger } from "./speech/speechService";
import { createSpeechTurnPlayer, type SpeechTurnPlayer } from "./speech/speechTurnPlayer";
import { SPEECH_EVENT_CHANNEL, SpeechEventSchema, type SpeechEvent } from "../ipc/speechPlayback";
import {
  VOICE_PILL_ACTIVITY_CHANNEL,
  VOICE_RECORD_COMMAND_CHANNEL,
  VOICE_RECORD_EVENT_CHANNEL,
  VoicePillActivitySchema,
  VoiceRecordCommandSchema,
  VoiceRecordEventSchema,
  type VoiceRecordCommand,
} from "../ipc/voiceInput";
import {
  MIC_OPEN_SETTINGS_CHANNEL,
  MIC_PERMISSION_REQUEST_CHANNEL,
  MIC_PERMISSION_STATUS_CHANNEL,
  MicPermissionStateSchema,
} from "../ipc/micPermission";
import {
  deriveMicPermissionState,
  type MicrophoneAccessStatus,
} from "./permissions/micPermissionState";
import {
  ACCESSIBILITY_OPEN_SETTINGS_CHANNEL,
  ACCESSIBILITY_PERMISSION_REQUEST_CHANNEL,
  ACCESSIBILITY_PERMISSION_STATUS_CHANNEL,
  AccessibilityPermissionStateSchema,
} from "../ipc/accessibilityPermission";
import { deriveAccessibilityPermissionState } from "./permissions/accessibilityPermissionState";
import { PushToTalkMonitor } from "./voice/pushToTalkMonitor";
import { createUiohookKeyEventSource } from "./voice/globalKeyEventSource";
import { VoiceLoopController } from "./voice/voiceLoopController";

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
// covers external edits; a missing file (first run) simply has no watcher yet - `watch`
// throws ENOENT on a path that does not exist, so guard on existence rather than logging
// a scary (and harmless) error on every fresh profile.
if (existsSync(routingConfigPath)) {
  try {
    watch(routingConfigPath, () => {
      routingConfigStore.reload();
    });
  } catch (error) {
    console.error("[lune] could not watch routing config file:", error);
  }
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

// The dev-only env fallback for each computer-use Vendor's key, mirroring the Reasoning
// fallback: the Screen Agent reuses Reasoning's Vendor selection + keys, so a keyed
// Anthropic/Gemini/OpenAI Vendor can act with no extra credential.
const COMPUTER_USE_API_KEY_ENV_BY_VENDOR: Record<ComputerUseVendorId, string> = {
  anthropic: API_KEY_ENV_BY_VENDOR.anthropic,
  google: API_KEY_ENV_BY_VENDOR.google,
  openai: API_KEY_ENV_BY_VENDOR.openai,
};

// The Core's Screen Agent Capability (M2-01): the server-side half of the Shell-driven
// agent loop. It advances one Session by one Step against the routed computer-use Vendor's
// adapter (Anthropic + Gemini + OpenAI wired), gated on that Vendor's computer-use
// capability + key exactly like Reasoning - a missing key (or a Vendor with no adapter)
// throws a typed not-ready without any upstream call. The M2-03 loop (below) drives it:
// only the Shell touches the OS; only the Core talks to the Vendor.
const screenAgentCapability = createScreenAgentCapability({
  getRoutingConfig: () => routingConfigStore.getConfig(),
  adapters: {
    anthropic: createAnthropicComputerUseAdapter(),
    google: createGeminiComputerUseAdapter(),
    openai: createOpenAiComputerUseAdapter(),
  },
  getApiKey: (vendorId) =>
    credentialStore.getKey(vendorId) ?? process.env[COMPUTER_USE_API_KEY_ENV_BY_VENDOR[vendorId]],
  upstreamFetch: (url, requestInit) => fetch(url, requestInit),
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

// Onboarding (ticket 14): the jargon-free first run. The completion flag is a Shell
// concern (a tiny userData file), so it lives here behind an injected fs seam; a fresh
// profile with no file reads as not-complete and gets onboarding, a returning user never
// sees it again. The service (composing key validation, the download, and completion) is
// assigned once the app is ready - it needs the Provisioning Capability - and the
// onboarding window opens only after the UI is up, so it is set before any onboarding IPC.
const onboardingStore = new OnboardingStore(
  join(app.getPath("userData"), "onboarding.json"),
  (path) => readFileSync(path, "utf8"),
  (path, contents) => writeFileSync(path, contents, "utf8"),
);
let onboardingService: OnboardingService | null = null;

/** The onboarding service once ready; an onboarding IPC before then is a programmer error. */
function requireOnboardingService(): OnboardingService {
  if (onboardingService === null) {
    throw new Error("Onboarding service is not ready yet");
  }
  return onboardingService;
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

// The Screen Agent Confirm Gate window (M2-04): the focusable on-screen chip that asks the
// user to approve/decline before Lune touches the OS. Created lazily on first gate; held
// here so it can be disposed on quit.
let confirmGateWindow: ConfirmGateWindow | null = null;

/** Registers a global accelerator, swallowing a malformed/taken-key failure (returns success). */
function registerGlobalShortcutSafely(accelerator: string, handler: () => void): boolean {
  try {
    return globalShortcut.register(accelerator, handler);
  } catch (error) {
    console.error(`[lune] could not register global shortcut ${accelerator}:`, error);
    return false;
  }
}

/** Unregisters a global accelerator, swallowing any failure so teardown never throws. */
function unregisterGlobalShortcutSafely(accelerator: string): void {
  try {
    globalShortcut.unregister(accelerator);
  } catch (error) {
    console.error(`[lune] could not unregister global shortcut ${accelerator}:`, error);
  }
}

// The Transcription lifecycle (ticket 10): the supervised whisper.cpp child + its Core
// Capability. Held at module scope so app-quit and abrupt-exit teardown can reach it to
// stop the child (developer story 41 - quitting orphans nothing). Assigned once the app
// is ready and Provisioning readiness is known.
let transcription: DesktopTranscription | null = null;

// The synthetic input executor (M2-02): the Shell's hands for the Screen Agent - performs
// canonical Actions as real OS input via the nut.js native backend, gated on the M1
// Accessibility grant. Assigned once the app is ready. The Screen Agent loop (a later M2
// ticket) will drive it; until then only the env-gated dev trigger exercises it.
let syntheticInputExecutor: SyntheticInputExecutor | null = null;

// The Screen Agent service (M2-03): the Shell-driven agent loop over the real edges - the
// Core step, the synthetic input executor, the overlay-excluded scene capture, and the
// confirm gate. Assigned once the app is ready (it needs the executor + overlay). No
// production consumer drives it yet (the advisory->act auto-routing is a later concern);
// the env-gated dev trigger below runs one bounded session end to end.
let screenAgentService: ScreenAgentService | null = null;

// The Speech Capability (ticket 09): on-device Kokoro synthesis, gated on the Kokoro
// weights being provisioned. Assigned once the app is ready (it needs the Provisioning
// readiness + models directory). A chat turn only runs after the UI is up, so it is set
// by then; when Kokoro isn't ready the turn simply answers in text without speaking.
let speechCapability: SpeechCapability | null = null;

// The Pill window: Lune's always-present home surface, and the one renderer that owns
// audio output, so synthesized speech clips are streamed to it. Assigned when the app
// creates the Pill.
let pillWindow: BrowserWindow | null = null;

// The push-to-talk voice loop (ticket 11): the orchestrator that turns the global
// hotkey into hold-to-talk + Barge-in. Assigned once the app is ready (it needs the
// Pill, Overlay, and Transcription). Held at module scope so the chat-start handler can
// register a typed turn with it for Barge-in, and teardown can stop the OS hook.
let voiceController: VoiceLoopController | null = null;

// The Overlay display currently showing the listening waveform, resolved at the cursor
// when a recording starts so the live level and the end signal reach the same window.
let listeningDisplayId: number | undefined;

/** This app's macOS microphone access, as the OS reports it (always granted off macOS). */
function getMicrophoneAccessStatus(): MicrophoneAccessStatus {
  if (process.platform !== "darwin") {
    return "granted";
  }
  return systemPreferences.getMediaAccessStatus("microphone") as MicrophoneAccessStatus;
}

/**
 * Whether this app is a trusted macOS Accessibility client (always true off macOS, where
 * there is no such trust model). Passing `prompt: true` pops the system Accessibility
 * pane; `false` is a silent check safe to call on a poll.
 */
function isAccessibilityTrusted(prompt: boolean): boolean {
  if (process.platform !== "darwin") {
    return true;
  }
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

/**
 * Opens System Settings straight to the Accessibility pane (a no-op off macOS). The
 * `x-apple.systempreferences:` URL is the same one the onboarding open-settings channel
 * uses; kept in one helper so the accessibility IPC handler and the Screen Agent's
 * degrade path (M2-02: route to the Accessibility pane when synthetic input is refused)
 * route to the same place.
 */
function openAccessibilitySettings(): void {
  if (process.platform === "darwin") {
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  }
}

/**
 * Whether a permission that onboarding covers (screen recording, microphone, or
 * Accessibility) is currently missing. The Pill has no permission UI of its own, so this
 * lets a returning user who has since revoked a grant be re-surfaced onboarding at its
 * permissions step rather than silently losing screen-aware answers, voice, or
 * push-to-talk. Accessibility is included from M1 (DECISIONS #22): the push-to-talk hook
 * needs it, so onboarding is the guided place to (re-)grant it.
 */
function requiredPermissionsMissing(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  return (
    getScreenMediaAccessStatus() !== "granted" ||
    getMicrophoneAccessStatus() !== "granted" ||
    !isAccessibilityTrusted(false)
  );
}

// Whether the push-to-talk hook has been started this run, so `startPushToTalkIfAccessible`
// is idempotent even when the onboarding permissions poll calls it repeatedly.
let pushToTalkStarted = false;

/**
 * Starts the global push-to-talk hook, but only when macOS Accessibility is *already*
 * granted - never prompting for it here. The uiohook global keyboard hook needs
 * Accessibility, and calling its `start()` while untrusted pops the system Accessibility
 * pane (libuiohook calls `AXIsProcessTrustedWithOptions` with the prompt option). The
 * onboarding permissions step owns the explicit grant prompt (M1, DECISIONS #22); this
 * helper only *starts* the hook once trust exists, so it can be called freely at boot, on
 * onboarding completion, and whenever a permission poll observes the grant. It is a no-op
 * until `voiceController` is ready and runs at most once.
 */
function startPushToTalkIfAccessible(): void {
  if (pushToTalkStarted || voiceController === null || !isAccessibilityTrusted(false)) {
    return;
  }
  voiceController.start();
  pushToTalkStarted = true;
}

/** Sends one recording command to the Pill renderer (which owns the mic), validated on the way out. */
function sendRecordCommand(command: VoiceRecordCommand): void {
  if (pillWindow === null || pillWindow.isDestroyed()) {
    return;
  }
  pillWindow.webContents.send(VOICE_RECORD_COMMAND_CHANNEL, VoiceRecordCommandSchema.parse(command));
}

/** Sets the Pill's voice-loop activity indicator (idle/listening/thinking). */
function setPillActivity(state: "idle" | "listening" | "thinking"): void {
  // Mirror the "thinking" phase onto the Overlay as a loading spinner right at the cursor,
  // so the user sees Lune is working (transcribing + reasoning) the whole time between the
  // hotkey release and the first streamed answer - not just the Pill's small state dot.
  // This is the single point every voice-loop transition passes through, so the spinner is
  // shown and cleared on every path (answered, empty transcript, not ready, error). The
  // answer's own `activity-start` also clears it when the reply begins to stream.
  if (overlayManager && listeningDisplayId !== undefined) {
    overlayManager.sendToDisplay(listeningDisplayId, {
      type: state === "thinking" ? "thinking-start" : "thinking-end",
    });
  }
  if (pillWindow === null || pillWindow.isDestroyed()) {
    return;
  }
  pillWindow.webContents.send(VOICE_PILL_ACTIVITY_CHANNEL, VoicePillActivitySchema.parse({ state }));
}

/** The window a voice turn streams its conversation events to: the Chat Panel if open, else the Pill. */
function voiceTurnWebContents(): WebContents | null {
  const panel = getChatPanelWebContents();
  if (panel !== null) {
    return panel;
  }
  return pillWindow !== null && !pillWindow.isDestroyed() ? pillWindow.webContents : null;
}

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

/** Warm, friendly nudges spoken when a push-to-talk hold caught no discernible speech. */
const NO_SPEECH_NUDGES = [
  "Hmm, I didn't quite catch that. Could you say it again a little louder?",
  "Sorry, I didn't hear anything - mind trying that once more, nice and clear?",
  "I couldn't make that out. Give it another go, a touch louder?",
  "Oops, that came through silent. Could you repeat it a bit closer to the mic?",
];

/**
 * Speaks a short, friendly "didn't catch that" nudge when a push-to-talk hold produced no
 * discernible speech, instead of transcribing a whisper hallucination and answering it. It
 * runs through the same Kokoro path as a real turn, so it also captions the line in step
 * with the voice. If Kokoro isn't ready (or the Pill is gone) it reports it didn't speak,
 * and the voice loop returns the Pill to idle itself.
 */
async function announceNoSpeech(): Promise<{ spoke: boolean }> {
  if (!speechCapability?.isReady() || pillWindow === null || pillWindow.isDestroyed()) {
    return { spoke: false };
  }
  const nudge = NO_SPEECH_NUDGES[Math.floor(Math.random() * NO_SPEECH_NUDGES.length)]!;
  const speechTurn = createSpeechTurnPlayer({
    speech: speechCapability,
    turnId: randomUUID(),
    sendEvent: sendSpeechEvent,
    encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
    // Caption the nudge (in step with the voice) when streaming text is on, like a turn.
    includeCaption: settingsStore.getStreamingText(),
  });
  await speechTurn.finish(nudge);
  return { spoke: true };
}

/**
 * Speaks one line through the same Kokoro path a turn uses - the Screen Agent's voice when
 * a run completes (or advises). A no-op when there is nothing to say, or when Kokoro isn't
 * ready / the Pill is gone, so the run still ends cleanly in text-only mode without hanging.
 */
async function speakLine(text: string): Promise<void> {
  if (text.trim().length === 0) {
    return;
  }
  if (!speechCapability?.isReady() || pillWindow === null || pillWindow.isDestroyed()) {
    return;
  }
  const speechTurn = createSpeechTurnPlayer({
    speech: speechCapability,
    turnId: randomUUID(),
    sendEvent: sendSpeechEvent,
    encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
    includeCaption: settingsStore.getStreamingText(),
  });
  await speechTurn.finish(text);
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

/** Whether a thrown error is the Barge-in abort (a cancelled turn), not a real failure. */
function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/** One conversation turn to run: how it arrived, where its events stream, and its abort signal. */
interface RunConversationTurnOptions {
  turnId: string;
  prompt: string;
  inputMethod: ChatInputMethod;
  includeScreen: boolean;
  /** Where the streamed conversation events go (the Chat Panel, or the Pill for voice). */
  webContents: WebContents;
  /** Aborts this turn mid-stream on Barge-in; the turn then leaves no trace and stays silent. */
  signal?: AbortSignal;
}

// Drive one conversation turn (text or voice): capture screen context, advance the Core
// conversation, stream its events to the renderer, and drive the Overlay + Kokoro speech.
// Shared by the typed Chat Panel path and the push-to-talk voice loop so both render and
// speak identically. A thrown Core error becomes a terminal `error` event so the renderer
// never hangs; a Barge-in abort ends the turn quietly (no error, nothing committed).
// Returns whether the turn engaged speech, so the caller knows who returns the Pill to idle.
async function runConversationTurn(options: RunConversationTurnOptions): Promise<{ spoke: boolean }> {
  const { turnId, prompt, inputMethod, includeScreen, webContents, signal } = options;

  sendConversationEvent(webContents, { type: "started", turnId, ipcVersion: LUNE_IPC_VERSION });

  // Suspend the following cursor before capturing so the overlay can never photograph
  // its own cursor/bubble into this turn's screen context. Suspending (not just hiding)
  // also pauses the 60fps follow poll, so it cannot re-show the overlay mid-capture.
  // Resumed the moment the capture completes (below), and in the catch as a safety net.
  overlayManager?.suspendFollowing();

  // Overlay driving state for this turn (ticket 07): the answer bubble + cursor run on
  // the display holding the user's cursor (screen 1, the model's primary focus). We
  // stream the answer with its trailing Point Tag stripped, then point once the tag is
  // complete. `sentCleanLength` tracks how much clean text the Overlay already has.
  let overlayActive = false;
  let accumulatedAnswer = "";
  let sentCleanLength = 0;
  let cursorDisplayId: number | undefined;
  // Kokoro speech for this turn (ticket 09): created only when Speech is ready, so a
  // not-ready Kokoro answers in text without speaking (and without hanging).
  let speechTurn: SpeechTurnPlayer | null = null;
  // Whether this turn actually engaged speech AND produced speakable text - only then
  // does Kokoro playback own the return to idle. Set at completion so an empty or
  // tag-only answer (nothing to speak) reports `spoke: false` and the caller idles the Pill.
  let speechEngaged = false;
  let spoke = false;

  // The streaming-text toggle (ticket 13): read once at the turn's start so a change
  // takes effect on the next turn. When off, the Overlay cursor still flies and points,
  // but the answer text is not streamed into its response bubble (voice-only preference).
  const showStreamingText = settingsStore.getStreamingText();

  try {
    // Capture the screen(s) first (when opted in and permitted) so the answer is
    // screen-aware; with no captures this is exactly a text-only turn (and no pointing).
    const { screens, geometry } = await captureScreensForTurn(includeScreen);

    // Capture done: bring the following cursor back so it tracks the mouse while the
    // answer streams (the interaction content is layered on top of it below).
    overlayManager?.resumeFollowing();

    cursorDisplayId =
      geometry.find((display) => display.screenNumber === 1)?.displayId ??
      overlayManager?.displayIdAt(screen.getCursorScreenPoint());

    for await (const coreEvent of conversationManager.submitUserTurn({
      text: prompt,
      inputMethod,
      screenshots: screens,
      signal,
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
              // Carry each spoken sentence as the Pill's caption line when the
              // streaming-text setting is on (ticket 13); voice-only when off.
              includeCaption: showStreamingText,
            });
            speechEngaged = true;
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
          // Stream the answer into the Overlay bubble, but only the clean human text, and
          // only when the streaming-text toggle is on.
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
          {
            const { directive, displayText } = parseAnswerPointTag(accumulatedAnswer);
            if (overlayManager && cursorDisplayId !== undefined) {
              // The full answer has streamed, so its trailing Point Tag (if any) is now
              // complete. The planner turns the parsed directive + capture geometry into
              // the exact messages to send (fly to the target on the correct monitor,
              // then close out), keeping the multi-monitor sequencing in one tested place.
              for (const message of planCompletionMessages(directive, geometry, cursorDisplayId)) {
                overlayManager.sendToDisplay(message.displayId, message.event);
              }
            }
            // The turn "spoke" only if speech was engaged AND there was speakable text;
            // an empty or tag-only answer plays no audio, so the caller must idle the Pill.
            spoke = speechEngaged && displayText.trim().length > 0;
          }
          // Flush the final (unterminated) sentence and let speech drain.
          await speechTurn?.finish(accumulatedAnswer);
          break;
        }
      }
    }

    // The turn committed in the Core, so persist the active conversation's text-only
    // history (ticket 12) and tell the panel its recent-list may have changed. A failed
    // or aborted turn throws above and never reaches here, matching the Core's rollback.
    conversationHistoryStore.save(activeConversationId, conversationManager.getMessages());
    notifyConversationsChanged(webContents);
  } catch (error) {
    // Safety net: if the turn threw before the capture completed, following is still
    // suspended - resume it so the cursor doesn't stay frozen/hidden. Idempotent.
    overlayManager?.resumeFollowing();
    // End any Overlay interaction this turn opened so the cursor fades out rather than
    // hanging.
    if (overlayManager && overlayActive && cursorDisplayId !== undefined) {
      overlayManager.sendToDisplay(cursorDisplayId, { type: "activity-end" });
    }
    // Halt this turn's speech worker so an interrupted (or failed) turn stops synthesizing
    // and emits no further clips - without this a Barge-in's old turn keeps speaking over
    // the new one. The Pill renderer also ignores a superseded turn's clips by turn id.
    speechTurn?.stop();
    if (isAbortError(error, signal)) {
      // A Barge-in is a deliberate interruption, not a failure: the controller already
      // stopped playback and the new turn owns the audio, so end quietly (no error
      // banner). The Core kept this interrupted turn in history (merge-on-interrupt), so
      // persist it - the next turn and the Chat Panel build on what the user just said.
      conversationHistoryStore.save(activeConversationId, conversationManager.getMessages());
      notifyConversationsChanged(webContents);
    } else {
      // A genuine failure: clear any audio already queued for this turn and surface it.
      if (speechTurn !== null) {
        sendSpeechEvent({ type: "stop" });
      }
      sendConversationEvent(webContents, { type: "error", turnId, message: describeChatError(error) });
    }
  }

  return { spoke };
}

// The typed Chat Panel turn (ticket 06): validate the request and run it, streaming its
// events back to the panel. It gets an abort handle registered with the voice loop, so
// pressing the push-to-talk hotkey during its playback is Barge-in (ticket 11).
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

  const abortController = new AbortController();
  voiceController?.noteExternalTurnStarted(abortController);
  void runConversationTurn({ turnId, prompt, inputMethod, includeScreen, webContents, signal: abortController.signal })
    .finally(() => voiceController?.noteTurnEnded(abortController));
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

// The onboarding surface's IPC (ticket 14): live-validate + store a Vendor key, start
// (or resume) the background download, poll its progress, open a "get a key" page, and
// mark completion. The catalog/keyed-Vendors/readiness the flow also needs are read over
// the Settings channels above (not duplicated here). Every payload is validated on the
// way in and every reply parsed on the way out (developer story 46).
ipcMain.handle(ONBOARDING_VALIDATE_KEY_CHANNEL, async (_event, rawRequest: unknown) => {
  const request = ValidateKeyRequestSchema.parse(rawRequest);
  return ValidateKeyResponseSchema.parse(await requireOnboardingService().validateAndSaveKey(request));
});
ipcMain.handle(ONBOARDING_DOWNLOAD_STATUS_CHANNEL, () =>
  OnboardingDownloadStatusSchema.parse(requireOnboardingService().downloadStatus()),
);
ipcMain.on(ONBOARDING_START_DOWNLOAD_CHANNEL, () => requireOnboardingService().startDownload());

// Completion persists the flag and closes the window; the Pill is the app's home from
// here on, and onboarding is never opened again (developer story: returning users skip it).
ipcMain.on(ONBOARDING_COMPLETE_CHANNEL, () => {
  requireOnboardingService().markComplete();
  closeOnboardingWindow();
  // Now that the user has reached the Pill, start the global push-to-talk hook - but only
  // if Accessibility is already granted, never prompting for it (M1 defers that flow to
  // M2, DECISIONS #22). Idempotent, so a returning user that already started it at boot
  // is unaffected; a user without Accessibility simply has hold-to-talk inactive.
  startPushToTalkIfAccessible();
});

// Open a Vendor's "get a key" page. The renderer sends only a Vendor id; the URL is
// looked up from the fixed catalog map, so no arbitrary renderer string is ever opened.
ipcMain.on(ONBOARDING_OPEN_GET_KEY_CHANNEL, (_event, rawVendor: unknown) => {
  const parsed = SettingsVendorIdSchema.safeParse(rawVendor);
  if (parsed.success) {
    void shell.openExternal(VENDOR_GET_KEY_URLS[parsed.data]);
  }
});

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

// The Pill reports each answer line as its audio begins (it owns Kokoro playback timing);
// mirror it onto the Overlay so the same line also reads out beside the cursor, in step
// with the voice. Broadcast to every drawing overlay so it lands wherever the buddy is.
ipcMain.on(PILL_CAPTION_CHANNEL, (_event, rawCaption: unknown) => {
  const parsed = PillCaptionSchema.safeParse(rawCaption);
  if (!parsed.success) {
    console.error("[lune] dropping malformed pill caption:", parsed.error.message);
    return;
  }
  overlayManager?.broadcast({
    type: "caption",
    id: parsed.data.id,
    words: parsed.data.words,
  });
});

// Whisper child-process teardown (ticket 10, developer story 41). `before-quit` runs
// on the normal quit path (pill menu, relaunch) and issues a SIGTERM via the
// supervisor. `exit` is the abrupt-exit net (uncaught error, hard exit) where only
// synchronous work runs, so it SIGKILLs the child directly - between them, a quit or
// crash never leaves a whisper-server process behind. (A parent SIGKILL can't be
// intercepted by anyone, but there is no owning watchdog process to route around it.)
app.on("before-quit", () => {
  void transcription?.shutdown();
  // Release the global keyboard hook so the native uiohook thread stops cleanly (ticket 11).
  voiceController?.stop();
  // Release any Confirm Gate resources (a gate open at quit would still hold Enter/Escape;
  // unregister just those, not every accelerator, and dispose the gate window).
  unregisterGlobalShortcutSafely("Enter");
  unregisterGlobalShortcutSafely("Escape");
  confirmGateWindow?.dispose();
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

// Deep-link System Settings to the exact permission pane. After macOS has recorded a
// denial it never re-prompts, so the denied-state button opens the pane where the user
// flips the toggle (the permission UI then live-detects the grant on its next poll). The
// `x-apple.systempreferences:` URLs open the specific Privacy panes on macOS; off macOS
// these are no-ops (the permissions themselves are ungated there).
ipcMain.on(SCREEN_OPEN_SETTINGS_CHANNEL, () => {
  if (process.platform === "darwin") {
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }
});
ipcMain.on(MIC_OPEN_SETTINGS_CHANNEL, () => {
  if (process.platform === "darwin") {
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  }
});

// Microphone permission (ticket 11, contract shared with ticket 14 onboarding). The
// status channel reads the OS state without prompting so the UI can poll it live; the
// request channel calls `askForMediaAccess`, which pops the macOS prompt on the first
// attempt and resolves once the user answers - so the flow live-detects the grant.
ipcMain.handle(MIC_PERMISSION_STATUS_CHANNEL, () =>
  MicPermissionStateSchema.parse(deriveMicPermissionState(getMicrophoneAccessStatus())),
);
ipcMain.handle(MIC_PERMISSION_REQUEST_CHANNEL, async () => {
  if (process.platform === "darwin" && getMicrophoneAccessStatus() === "not-determined") {
    // Prompts once and resolves when the user answers; a no-op if already decided.
    await systemPreferences.askForMediaAccess("microphone").catch(() => false);
  }
  return MicPermissionStateSchema.parse(deriveMicPermissionState(getMicrophoneAccessStatus()));
});

// Accessibility permission (M1 onboarding permissions step; consumed by the push-to-talk
// voice loop, whose global uiohook hook needs Accessibility). The status channel is a
// silent read the onboarding step polls; the request channel pops the system prompt that
// routes to System Settings (macOS cannot grant Accessibility inline); the open-settings
// channel is the second route to the toggle. Whenever a read observes the grant, we start
// the push-to-talk hook so hold-to-talk goes live without a restart.
ipcMain.handle(ACCESSIBILITY_PERMISSION_STATUS_CHANNEL, () => {
  const trusted = isAccessibilityTrusted(false);
  if (trusted) {
    startPushToTalkIfAccessible();
  }
  return AccessibilityPermissionStateSchema.parse(deriveAccessibilityPermissionState(trusted));
});
ipcMain.handle(ACCESSIBILITY_PERMISSION_REQUEST_CHANNEL, () => {
  // `prompt: true` pops the system Accessibility pane. It returns the current trust state
  // synchronously (still not-granted until the user flips the toggle), which the next poll
  // then detects; if trust is already present, start the hook immediately.
  const trusted = isAccessibilityTrusted(true);
  if (trusted) {
    startPushToTalkIfAccessible();
  }
  return AccessibilityPermissionStateSchema.parse(deriveAccessibilityPermissionState(trusted));
});
ipcMain.on(ACCESSIBILITY_OPEN_SETTINGS_CHANNEL, () => {
  openAccessibilitySettings();
});

// The Pill's recording events (live level, finished clip, capture error) drive the voice
// loop. Validated on the way in, then handed to the controller (which ignores events
// from a superseded recording). Before the controller is ready, there are no recordings.
ipcMain.on(VOICE_RECORD_EVENT_CHANNEL, (_event, rawRecordEvent: unknown) => {
  const parsedEvent = VoiceRecordEventSchema.safeParse(rawRecordEvent);
  if (!parsedEvent.success) {
    console.error("[lune] dropping malformed voice record event:", parsedEvent.error.message);
    return;
  }
  voiceController?.handleRecordEvent(parsedEvent.data);
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

  // The Screen Agent Confirm Gate window (M2-04): the on-screen chip. Kept hidden until a
  // gate opens; the controller below drives it alongside the hotkey and voice modalities.
  confirmGateWindow = new ConfirmGateWindow();

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
  // AND its child Runtime is healthy. The binary comes from a pinned-source build: in a
  // packaged app it is staged into the bundle's Resources (ticket 15), and in dev it is
  // pointed at via LUNE_WHISPER_SERVER_PATH (absent → whisper reports not-ready).
  transcription = createDesktopTranscription({
    modelsDirectoryPath: provisioning.modelsDirectoryPath,
    isWhisperProvisioned: () => provisioning.capability.isRuntimeReady("whisper"),
    whisperServerBinaryPath: resolveWhisperServerBinaryPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      envOverride: process.env[WHISPER_SERVER_PATH_ENV],
      // In a dev launch, fall back to the repo's locally-built binary (the same
      // `build/whisper-server` electron-builder stages into the bundle - resolved two
      // levels up from the desktop app dir), so a dev build transcribes with no env var
      // to set. `app.getAppPath()` is the desktop package dir; the repo root is its
      // grandparent (apps/desktop → repo).
      devFallbackBinaryPath: join(app.getAppPath(), "..", "..", "build", WHISPER_SERVER_RESOURCE_NAME),
      fileExists: (candidatePath) => existsSync(candidatePath),
    }),
  });

  // Speech (ticket 09): the in-process Kokoro engine, gated on the Kokoro weights being
  // provisioned + verified (read live, so readiness flips automatically when a download
  // completes - no rebuild). The Voice comes from the routing config.
  speechCapability = createDesktopSpeech({
    modelsDirectoryPath: provisioning.modelsDirectoryPath,
    getRoutingConfig: () => routingConfigStore.getConfig(),
    isKokoroReady: () => provisioning.capability.isRuntimeReady("kokoro"),
  });

  // Synthetic input executor (M2-02): the Screen Agent's hands. Built over the nut.js
  // native backend + Electron clipboard, reusing the M1 Accessibility grant. No consumer
  // drives it yet (the Screen Agent loop is a later M2 ticket); the env-gated dev trigger
  // below is the only caller for now.
  syntheticInputExecutor = createDesktopSyntheticInputExecutor();

  // Screen Agent loop (M2-03): compose the Shell-driven agent loop over the real edges -
  // the Core step, the executor above, and the overlay-excluded scene capture (the overlay
  // manager suspends its own windows around each capture so Lune never photographs itself).
  // The confirm gate (M2-04) is the real chip/voice/hotkey UX: the controller reconciles the
  // three modalities, the chip is the focusable gate window, the hotkey is Enter/Escape
  // registered only while a gate is open, and voice reuses push-to-talk (diverted to the
  // gate so a spoken answer never barges in the run). `speak` uses the same Kokoro path as a
  // turn. The env-gated dev trigger below is the only caller for now (advisory->act is later).
  screenAgentService = createScreenAgentService({
    capability: screenAgentCapability,
    executor: syntheticInputExecutor,
    // Assigned at the top of `whenReady`, above; non-null by the time the service is built.
    overlay: overlayManager!,
    speak: (text) => {
      void speakLine(text);
    },
    confirm: createConfirmGateController({
      speak: (text) => {
        void speakLine(text);
      },
      showChip: (view) => {
        confirmGateWindow?.open(view);
        return () => confirmGateWindow?.close();
      },
      armAnswerCapture: (deliver) => {
        // The chip's Approve/Cancel buttons.
        const offChip =
          confirmGateWindow?.onAnswer((intent) => deliver({ source: "chip", intent })) ?? (() => {});
        // The hotkey: while the gate is open, Enter approves and Escape cancels from
        // anywhere. Registered only for the gate's lifetime and released on resolve. Guarded
        // so that if a key can't be registered (already held, or rejected on a platform), the
        // chip and voice modalities still answer the gate rather than the whole arm failing.
        registerGlobalShortcutSafely("Enter", () => deliver({ source: "hotkey", intent: "approve" }));
        registerGlobalShortcutSafely("Escape", () => deliver({ source: "hotkey", intent: "cancel" }));
        // Voice: push-to-talk answers the gate (hold to speak "yes"/"no") instead of barging
        // in the run the gate guards.
        const offVoice =
          voiceController?.openConfirmGateCapture((transcript) =>
            deliver({ source: "voice", transcript }),
          ) ?? (() => {});
        return () => {
          offChip();
          unregisterGlobalShortcutSafely("Enter");
          unregisterGlobalShortcutSafely("Escape");
          offVoice();
        };
      },
    }),
    generateSessionId: () => randomUUID(),
  });

  // Push-to-talk voice loop (ticket 11): the global-hotkey orchestrator. It reads the
  // hotkey live from the routing config (editable in Settings, ticket 13), records
  // through the Pill, transcribes on release via whisper, and answers the transcript as
  // a screen-aware voice turn - reusing the same turn runner as the Chat Panel so voice
  // and text share one history. Barge-in (a hotkey press mid-answer) aborts the in-flight
  // turn's Reasoning stream and speech, then starts a fresh recording.
  voiceController = new VoiceLoopController({
    monitor: new PushToTalkMonitor({
      keySource: createUiohookKeyEventSource(),
      getHotkeyToken: () => routingConfigStore.getConfig().hotkey.pushToTalk,
    }),
    isTranscriptionReady: () => transcription?.capability.isReady() ?? false,
    transcribe: async (audioWav) => (await transcription!.capability.transcribe(audioWav)).text,
    sendRecordCommand,
    setPillActivity,
    stopSpeech: () => sendSpeechEvent({ type: "stop" }),
    overlayListenStart: () => {
      // Resolve the cursor's display once, so the level and end signal reach the same one.
      listeningDisplayId = overlayManager?.displayIdAt(screen.getCursorScreenPoint());
      if (overlayManager && listeningDisplayId !== undefined) {
        overlayManager.sendToDisplay(listeningDisplayId, { type: "listen-start" });
      }
    },
    overlayListenLevel: (level) => {
      if (overlayManager && listeningDisplayId !== undefined) {
        overlayManager.sendToDisplay(listeningDisplayId, { type: "listen-level", level });
      }
    },
    overlayListenEnd: () => {
      if (overlayManager && listeningDisplayId !== undefined) {
        overlayManager.sendToDisplay(listeningDisplayId, { type: "listen-end" });
      }
    },
    runVoiceTurn: async ({ turnId, prompt, signal }) => {
      const webContents = voiceTurnWebContents();
      if (webContents === null) {
        // No window to stream to (the Pill is gone): nothing to answer into.
        return { spoke: false };
      }
      // The loading spinner is raised by `setPillActivity("thinking")` on hotkey release
      // (so it shows through transcription too). This finally is the guaranteed cleanup for
      // the cursor's display: a turn that spoke returns to idle via Kokoro playback (never
      // `setPillActivity("idle")`), and the answer may have streamed on a different display,
      // so clear the spinner on the listening display here whatever happened.
      const thinkingDisplayId = listeningDisplayId;
      try {
        return await runConversationTurn({
          turnId,
          prompt,
          inputMethod: "voice",
          includeScreen: true,
          webContents,
          signal,
        });
      } finally {
        if (overlayManager && thinkingDisplayId !== undefined) {
          overlayManager.sendToDisplay(thinkingDisplayId, { type: "thinking-end" });
        }
      }
    },
    announceNoSpeech: async () => {
      // Clear the thinking spinner on the listening display when the nudge speaks (or if it
      // can't), mirroring the real-turn cleanup so the loading state never lingers.
      const thinkingDisplayId = listeningDisplayId;
      try {
        return await announceNoSpeech();
      } finally {
        if (overlayManager && thinkingDisplayId !== undefined) {
          overlayManager.sendToDisplay(thinkingDisplayId, { type: "thinking-end" });
        }
      }
    },
    generateId: () => randomUUID(),
    decodeBase64: (base64) => new Uint8Array(Buffer.from(base64, "base64")),
  });
  // The global push-to-talk hook (uiohook) needs macOS Accessibility permission, and
  // calling its start() while untrusted pops that System Settings pane. M1 never drives
  // the Accessibility flow (deferred to M2, DECISIONS #22), so start the hook only when
  // Accessibility is already granted and otherwise stay silent - no boot-time prompt for
  // returning users, no jarring pane during first run.
  startPushToTalkIfAccessible();

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

  // Onboarding (ticket 14): now that the Settings service + Provisioning exist, wire the
  // service the onboarding IPC calls. Key validation is the cheap Core test call with the
  // platform `fetch` injected; the download is the one shared Provisioning run (started
  // silently at the welcome screen, resumed on a re-launched onboarding).
  onboardingService = createOnboardingService({
    settingsService,
    validateKey: (vendorId, key) =>
      validateReasoningKey({
        vendor: findReasoningVendor(vendorId),
        apiKey: key,
        upstreamFetch: (url, requestInit) => fetch(url, requestInit),
      }),
    provisioningStatus: () => provisioning.capability.status(),
    isAllProvisioned: () => REPAIR_RUNTIME_IDS.every((runtimeId) => provisioning.capability.isRuntimeReady(runtimeId)),
    startProvisioning: () => {
      provisioning.capability.start(REPAIR_RUNTIME_IDS);
      void provisioning.capability.awaitCurrentRun().then(() => transcription?.reconcile());
    },
    onboardingStore,
  });

  // First run, or a returning user who has since revoked a required permission (screen
  // recording or mic): open onboarding. It opens after Provisioning readiness is wired (so
  // the welcome screen's silent download can start), but before the async dev triggers
  // below - no-ops on a normal launch. The renderer resumes to the furthest incomplete
  // step, so a returning user who already has a key + finished download lands directly on
  // the permissions step to re-grant (the Pill has no permission UI of its own). A
  // returning user with every permission intact goes straight to the Pill.
  if (!onboardingStore.isComplete() || requiredPermissionsMissing()) {
    openOnboardingWindow();
  }

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
    // Exercise the synthetic input executor end to end (M2-02 acceptance #1) via the
    // nut.js native edge; env-gated on LUNE_AGENT_INPUT_DEV, so a no-op on a normal launch.
    // If Accessibility is missing it routes to the pane (acceptance #3), never a silent no-op.
    await runSyntheticInputDevTrigger(syntheticInputExecutor!, {
      routeToAccessibilityPane: openAccessibilitySettings,
    });
    // Run one full Screen Agent session end to end (M2-03 acceptance #1) from the goal in
    // LUNE_AGENT_LOOP_DEV; a no-op on a normal launch. Barge-in is real: the session's abort
    // handle is registered with the voice loop, so a push-to-talk press cancels it mid-run
    // (acceptance #4), and a missing Accessibility grant routes to the pane (never a silent
    // no-op).
    await runScreenAgentDevTrigger(screenAgentService!, {
      routeToAccessibilityPane: openAccessibilitySettings,
      registerBargeIn: (abort) => voiceController?.noteExternalTurnStarted(abort),
      unregisterBargeIn: (abort) => voiceController?.noteTurnEnded(abort),
    });
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
