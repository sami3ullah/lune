import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { app, BrowserWindow, ipcMain, nativeImage, safeStorage, screen, shell, systemPreferences, type WebContents } from "electron";
import {
  buildMarkRefinementRequest,
  createAnthropicComputerUseAdapter,
  createConversationManager,
  createGeminiComputerUseAdapter,
  createReasoningCapability,
  createScreenAgentCapability,
  createVisionDrivenAgentAdapter,
  VISION_DRIVEN_VENDORS,
  ComputerUseUpstreamError,
  describeCore,
  findReasoningVendor,
  listReasoningModels,
  parseAnswerActTag,
  parseAnswerPointTag,
  parseAnswerShapeTags,
  parseMarkRefinementReply,
  PROVISIONING_MANIFEST,
  RoutingConfigStore,
  validateReasoningKey,
  type ComputerUseVendorId,
  type ParsedShape,
  type PointDirective,
  type ReasoningVendorId,
  type ScreenCaptureInput,
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
import { formatReasoningCompletion, isReasoningDebugEnabled } from "./reasoningDebugLog";
import {
  CONVERSATIONS_ACTIVE_CHANNEL,
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
  SETTINGS_LIST_MODELS_CHANNEL,
  SETTINGS_READINESS_CHANNEL,
  SETTINGS_REPAIR_CHANNEL,
  SETTINGS_SAVE_CHANNEL,
  SETTINGS_SET_KEY_CHANNEL,
  SETTINGS_TOGGLE_CHANNEL,
  SETTINGS_VALIDATE_KEY_CHANNEL,
  ListModelsRequestSchema,
  ListModelsResponseSchema,
  ReadinessRowSchema,
  SetApiKeyRequestSchema,
  SettingsSnapshotSchema,
  SettingsStateSchema,
  SettingsValuesSchema,
  ValidateKeyRequestSchema,
  ValidateKeyResponseSchema,
} from "../ipc/settings";
import { VENDOR_GET_KEY_URLS, SettingsVendorIdSchema } from "../ipc/settings";
import { SettingsStore } from "./settings/settingsStore";
import { CredentialStore } from "./settings/credentialStore";
import { createSettingsService, type SettingsService } from "./settings/settingsService";
import {
  ONBOARDING_COMPLETE_CHANNEL,
  ONBOARDING_DOWNLOAD_STATUS_CHANNEL,
  ONBOARDING_OPEN_GET_KEY_CHANNEL,
  ONBOARDING_SET_INTRO_VIDEO_CHANNEL,
  ONBOARDING_START_DOWNLOAD_CHANNEL,
  ONBOARDING_VALIDATE_KEY_CHANNEL,
  OnboardingDownloadStatusSchema,
} from "../ipc/onboarding";
import { OnboardingStore } from "./onboarding/onboardingStore";
import { createOnboardingService, type OnboardingService } from "./onboarding/onboardingService";
import { closeOnboardingWindow, getOnboardingWindowBounds, openOnboardingWindow } from "./onboardingWindow";
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
  type NativeScreenCapture,
} from "./screenCapture/captureDisplays";
import { OverlayWindowManager } from "./overlay/overlayWindows";
import { planCompletionMessages } from "./overlay/overlayPointing";
import { planShapeMessages } from "./overlay/overlayShapes";
import { DrawingScrollTracker } from "./overlay/drawingScrollTracker";
import {
  luminanceImageFromBitmap,
  snapPointToElement,
  snapShapeToElement,
  type SnapImage,
} from "./overlay/elementSnap";
import {
  applyRefinedBoxToShape,
  guessBoxForPoint,
  guessBoxForShape,
  planMarkCrop,
  refinedBoxIsPlausible,
  refinedPointFromBox,
  type PlannedMarkCrop,
} from "./overlay/markRefinement";
import type { DisplayCaptureGeometry } from "./overlay/overlayGeometry";
import { subscribeGlobalInput } from "./input/globalInputHook";
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
import type { ScreenAgentRunResult } from "./agent/screenAgentLoop";
import { createConfirmGateController } from "./agent/confirmGateController";
import type { AgentCursorOverlay } from "./agent/agentCursorPresenter";
import {
  resolveWhisperServerBinaryPath,
  WHISPER_SERVER_PATH_ENV,
  WHISPER_SERVER_RESOURCE_NAME,
} from "./transcription/whisperServerBinaryPath";
import { createDesktopSpeech, runSpeechDevTrigger } from "./speech/speechService";
import { createSpeechTurnPlayer, type SpeechTurnPlayer } from "./speech/speechTurnPlayer";
import { createFillerClipCache, type FillerClipCache } from "./speech/fillerClipCache";
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
    // OpenAI acts through the vision-driven adapter (M2-07), not the dedicated
    // computer_use_preview tool: that tool is org-verification-gated (the M2-06 field
    // blocker), whereas the vision-driven path runs on the user's ordinary gpt-* chat
    // Model Slot, so acting works the moment their OpenAI key does. The dedicated
    // `createOpenAiComputerUseAdapter` stays available as an optional high-fidelity mode.
    openai: createVisionDrivenAgentAdapter(VISION_DRIVEN_VENDORS.openai),
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

// The active conversation the next turn belongs to. Each app launch starts a fresh,
// unpersisted conversation (minted here, persisted only once its first turn completes),
// so a run's turns group into their own conversation rather than accreting forever into
// whichever one happened to be most recent. Prior conversations stay in the durable
// last-10 set and are resumable from the Chat Panel's dropdown; the Core begins empty.
let activeConversationId: string = randomUUID();

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

// The stale-drawing guard: teaching drawings are anchored to the screenshot their turn
// captured, so a global scroll clears a visible drawing at once and marks an in-flight
// turn's capture stale (its shapes/point are then suppressed rather than drawn on
// content that has scrolled away). Fed by the shared global input hook's wheel events.
const drawingScrollTracker = new DrawingScrollTracker();

// The teaching-drawing epoch: bumped when a new answer begins (the moment the previous
// turn's drawing is cleared). A turn's deferred mark presentation - shapes are drawn only
// after the refinement calls settle - snapshots this at completion and declines to draw
// when a newer answer has started meanwhile, so a slow refinement can never paint a stale
// turn's marks over the new turn's.
let teachingDrawingEpoch = 0;

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

// The instant-acknowledgement cache: pre-synthesized filler clips ("hmm, let me see.")
// a voice turn plays the moment it starts, so Lune answers back right away while the
// screen capture, the model's first sentence, and its synthesis are still in flight.
// Assigned with the Speech Capability; `null` (or an unprimed cache) means voice turns
// simply start without a filler, exactly as before.
let fillerClipCache: FillerClipCache | null = null;

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
 * A friendly, spoken explanation of a Screen Agent run's `error` cause. When the failure is
 * a typed upstream error, the HTTP status tells the user - in plain language, not a status
 * code - what actually happened and what to do (quota used up, a bad key, a model their key
 * can't reach, the Vendor being down). Anything else falls back to a generic apology.
 */
function describeScreenAgentError(error: unknown): string {
  if (error instanceof ComputerUseUpstreamError) {
    const vendor = error.vendorDisplayName.toLowerCase();
    if (error.status === 429) {
      return `looks like your ${vendor} api quota is used up right now, so i can't act on your screen. you may need to check your plan and billing, or try again in a little while.`;
    }
    if (error.status === 401 || error.status === 403) {
      return `${vendor} wouldn't accept your api key for controlling the computer - it might be invalid or missing access. you can update it in settings.`;
    }
    if (error.status === 404) {
      return `your ${vendor} key doesn't have access to the model i need to control the computer. you might need to enable it on your account, or switch to another vendor in settings.`;
    }
    if (error.status >= 500) {
      return `${vendor} had a server problem just now, so i couldn't finish. try again in a bit.`;
    }
    return `${vendor} turned down the request to act on your screen. try again, or check your account.`;
  }
  return "something went wrong while i was doing that, sorry.";
}

/**
 * Speaks a short degrade line for a Screen Agent run that could not complete on its own,
 * so acting never fails silently. `completed` (the loop already spoke its summary) and the
 * user-initiated stops (`declined` at the gate, `cancelled` by barge-in) deliberately say
 * nothing - the user already knows the outcome.
 */
async function announceScreenAgentOutcome(result: ScreenAgentRunResult): Promise<void> {
  switch (result.reason) {
    case "accessibility":
      // Route to the pane (the same degrade path the dev trigger uses) and say why, rather
      // than a silent no-op (the epic's Accessibility rule).
      openAccessibilitySettings();
      await speakLine(
        "i need accessibility permission to control your computer. i've opened the settings for you - turn lune on there and ask me again.",
      );
      break;
    case "not-ready":
      await speakLine(
        "i can't act on your screen with the model you're using right now. pick one that supports computer control in settings.",
      );
      break;
    case "unavailable":
      await speakLine("i can't control the computer right now, sorry.");
      break;
    case "step-cap":
    case "timeout":
    case "no-progress":
      await speakLine("i got stuck on that one and stopped. want to try again a different way?");
      break;
    case "error":
      // Turn the underlying cause into a plain-language spoken line (quota, bad key, model
      // access, vendor down) rather than one opaque "something went wrong".
      await speakLine(describeScreenAgentError(result.error));
      break;
    case "completed":
    case "declined":
    case "cancelled":
      // Nothing to add: the loop spoke its own summary, or the user stopped it themselves.
      break;
  }
}

/**
 * The advisory->act handoff (DECISIONS #14): when an ordinary turn's answer carried an
 * `[ACT: goal]` tag, the user asked Lune to actually do something on screen, so hand the
 * distilled goal to the Screen Agent and run it to a terminal outcome. Confirm-to-start
 * (M2-04) gates the first OS touch, and the run shares the turn's barge-in `signal` so a
 * push-to-talk press cancels it mid-run. Never throws - the loop resolves every failure to
 * a typed reason {@link announceScreenAgentOutcome} surfaces.
 */
async function runActHandoff(goal: string, signal: AbortSignal | undefined): Promise<boolean> {
  if (screenAgentService === null || signal?.aborted === true) {
    return false;
  }
  console.log(`[lune] screen agent: starting run for goal "${goal}"`);
  const result = await screenAgentService.run({ goal, signal });
  console.log(
    `[lune] screen agent: run ended (${result.reason}) after ${result.stepsExecuted} step(s)`,
  );
  if (result.error !== undefined) {
    // The underlying cause (an upstream HTTP status + the Vendor's error body, a capture
    // failure, a bad step input) - logged in full so a failed run is diagnosable rather
    // than hidden behind the spoken "something went wrong".
    console.error("[lune] screen agent: run error:", result.error);
  }
  await announceScreenAgentOutcome(result);
  // Report whether the run queued speech (its summary, or a spoken degrade line) so the
  // caller knows whether Kokoro playback owns the Pill's return to idle. A user-stopped run
  // (declined/cancelled) and an unready Kokoro both say nothing.
  const outcomeSpeaks = result.reason !== "declined" && result.reason !== "cancelled";
  return outcomeSpeaks && speechCapability?.isReady() === true;
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
    return { screens: [], geometry: [], nativeCaptures: [] };
  }
  try {
    return await captureConnectedDisplays();
  } catch (error) {
    console.error("[lune] screen capture failed; answering text-only:", error);
    return { screens: [], geometry: [], nativeCaptures: [] };
  }
}

/**
 * Lazily decodes this turn's captured screenshots into the grayscale images element
 * snapping reads, memoized per screen number so several marks on one screen decode its
 * JPEG once. `null` for a screen with no capture (or an undecodable one) - marks there
 * keep the model's own coordinates. `screens[i]` and `geometry[i]` come from the same
 * capture pass in the same order, so the screen number resolves through the geometry.
 */
function createSnapImageCache(
  screens: ScreenCaptureInput[],
  geometry: DisplayCaptureGeometry[],
): (screenNumber: number | null) => SnapImage | null {
  const cache = new Map<number, SnapImage | null>();
  return (screenNumber) => {
    // A null screen means the cursor's screen (screen 1), the same rule the resolvers use.
    const resolved = screenNumber ?? 1;
    const cached = cache.get(resolved);
    if (cached !== undefined) {
      return cached;
    }
    const index = geometry.findIndex((display) => display.screenNumber === resolved);
    const screen = index >= 0 ? screens[index] : undefined;
    let snapImage: SnapImage | null = null;
    if (screen !== undefined) {
      try {
        const decoded = nativeImage.createFromBuffer(Buffer.from(screen.base64Data, "base64"));
        const { width, height } = decoded.getSize();
        if (width > 0 && height > 0) {
          snapImage = luminanceImageFromBitmap(decoded.toBitmap(), width, height);
        }
      } catch (error) {
        console.error("[lune] element snap: could not decode this turn's capture:", error);
      }
    }
    cache.set(resolved, snapImage);
    return snapImage;
  };
}

/**
 * A refinement call may not hold the drawing hostage: past this, the mark falls back to
 * the element snap. The marks refine concurrently but draw together (one `Promise.all`),
 * so the drawing waits for the slowest call - and a single stuck vendor call would delay
 * every mark. Good refinements land in ~2-2.5s, so this caps the worst case a beat past
 * that: a call still running here is almost certainly hung, not slow-but-useful.
 */
const MARK_REFINEMENT_TIMEOUT_MS = 4500;

/**
 * Runs one mark-refinement call: cuts the planned crop from the native capture, asks the
 * routed Reasoning Vendor where exactly the labeled element sits in it, and returns the
 * element's box in crop pixels - or `null` on any failure (no key, timeout, a [NONE] or
 * garbled reply), in which case the caller keeps the mark's original coordinates. The
 * crop rides the ordinary Reasoning pipeline, so every Vendor refines for free.
 */
async function refineMarkAgainstVendor(input: {
  nativeCapture: NativeScreenCapture;
  plan: PlannedMarkCrop;
  label: string;
  signal?: AbortSignal;
}): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  const { nativeCapture, plan, label, signal } = input;
  try {
    const decoded = nativeImage.createFromBuffer(Buffer.from(nativeCapture.base64Data, "base64"));
    if (decoded.isEmpty()) {
      return null;
    }
    const crop = decoded.crop(plan.crop);
    const cropSize = crop.getSize();
    if (cropSize.width <= 0 || cropSize.height <= 0) {
      return null;
    }

    const request = buildMarkRefinementRequest({
      base64Data: crop.toJPEG(80).toString("base64"),
      mediaType: "image/jpeg",
      widthInPixels: cropSize.width,
      heightInPixels: cropSize.height,
      // The model attached no label to this mark: name the thing generically so the
      // grounding question is still answerable ("the ui element near the center").
      label: label.length > 0 ? label : "the ui element nearest the center of this image",
      hint: plan.guessInCrop,
    });

    // The call is bounded by its own abort (timeout) chained to the turn's Barge-in
    // signal, so a stopped turn also stops its refinements at the network source.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), MARK_REFINEMENT_TIMEOUT_MS);
    const onTurnAbort = (): void => abort.abort();
    signal?.addEventListener("abort", onTurnAbort, { once: true });
    if (signal?.aborted) {
      abort.abort();
    }
    try {
      let reply = "";
      for await (const event of reasoningCapability.streamChat(request, { signal: abort.signal })) {
        if (event.type === "text-delta") {
          reply += event.text;
        }
      }
      const box = parseMarkRefinementReply(reply, cropSize.width, cropSize.height);
      if (box === null) {
        // Always loud: a refinement that silently degrades to the fallback is exactly
        // how a wrong drawing becomes undiagnosable. An empty reply usually means the
        // Model Slot spent the whole token budget on hidden reasoning.
        const shownReply = reply.length === 0 ? "(empty reply)" : reply.slice(0, 160);
        console.log(`[lune] mark refinement: no usable box for "${label}" - ${shownReply}`);
      }
      return box;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onTurnAbort);
    }
  } catch (error) {
    console.log(
      `[lune] mark refinement: call failed for "${label}" -`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Refines this turn's teaching marks against the Vendor (the drawing-accuracy fix): every
 * "focus an element" shape and the pointing target gets one zoomed native-resolution crop
 * call that recovers the element's true bounds; a mark whose call fails (or whose shape
 * kind carries meaning a box can't recover) is returned unchanged and left to the element
 * snap. All calls run concurrently - a turn rarely has more than a few marks.
 */
async function refineTurnMarks(input: {
  shapes: ParsedShape[];
  directive: PointDirective;
  geometry: DisplayCaptureGeometry[];
  nativeCaptures: NativeScreenCapture[];
  signal?: AbortSignal;
}): Promise<{ shapes: ParsedShape[]; directive: PointDirective; refinedCount: number }> {
  const { shapes, directive, geometry, nativeCaptures, signal } = input;

  // Per-screen lookup of the native capture and the model-image (captured) dimensions the
  // marks' coordinates live in. A null shape screen means the cursor's screen (screen 1).
  const contextFor = (
    screenNumber: number | null,
  ): { nativeCapture: NativeScreenCapture; captured: { width: number; height: number } } | null => {
    const resolved = screenNumber ?? 1;
    const display = geometry.find((candidate) => candidate.screenNumber === resolved);
    const nativeCapture = nativeCaptures.find((candidate) => candidate.screenNumber === resolved);
    if (display === undefined || nativeCapture === undefined) {
      return null;
    }
    return {
      nativeCapture,
      captured: { width: display.capturedWidth, height: display.capturedHeight },
    };
  };

  let refinedCount = 0;

  const refinedShapes = shapes.map(async (shape): Promise<ParsedShape> => {
    const guess = guessBoxForShape(shape);
    const context = guess === null ? null : contextFor(shape.screenNumber);
    if (guess === null || context === null) {
      return shape;
    }
    const plan = planMarkCrop(guess, context.captured, {
      width: context.nativeCapture.widthInPixels,
      height: context.nativeCapture.heightInPixels,
    });
    if (plan === null) {
      return shape;
    }
    const box = await refineMarkAgainstVendor({
      nativeCapture: context.nativeCapture,
      plan,
      label: shape.label,
      signal,
    });
    if (box === null) {
      return shape;
    }
    if (!refinedBoxIsPlausible(guess, box, plan, true)) {
      console.log(
        `[lune] mark refinement: implausible box for "${shape.label}" ` +
          `(way off the mark's own size); keeping original coordinates`,
      );
      return shape;
    }
    refinedCount += 1;
    return applyRefinedBoxToShape(shape, box, plan, context.captured);
  });

  const refinedDirective = (async (): Promise<PointDirective> => {
    if (directive.kind !== "point") {
      return directive;
    }
    const context = contextFor(directive.point.screenNumber);
    if (context === null) {
      return directive;
    }
    const plan = planMarkCrop(guessBoxForPoint(directive.point), context.captured, {
      width: context.nativeCapture.widthInPixels,
      height: context.nativeCapture.heightInPixels,
    });
    if (plan === null) {
      return directive;
    }
    const box = await refineMarkAgainstVendor({
      nativeCapture: context.nativeCapture,
      plan,
      label: directive.point.label,
      signal,
    });
    if (box === null) {
      return directive;
    }
    refinedCount += 1;
    const point = refinedPointFromBox(box, plan);
    return { kind: "point", point: { ...directive.point, x: point.x, y: point.y } };
  })();

  const [shapesResult, directiveResult] = await Promise.all([
    Promise.all(refinedShapes),
    refinedDirective,
  ]);
  return { shapes: shapesResult, directive: directiveResult, refinedCount };
}

/**
 * Presents a completed turn's marks - the teaching shapes and the pointing flight - after
 * the drawing-accuracy work has settled. Runs detached from the turn (the spoken answer
 * plays meanwhile): first every mark is refined against the Vendor (a zoomed
 * native-resolution crop recovers the element's true bounds); marks the refinement
 * couldn't improve fall back to the local element snap. Because time passed while
 * refining, the world is re-checked before anything draws: a Barge-in or a newer answer
 * means this turn no longer owns the Overlay (return silently - the abort cleanup or the
 * new turn owns it), and a scroll means the coordinates aim at moved content (end the
 * interaction without marking anything). Never throws - a failure inside falls back to
 * presenting the unrefined marks rather than leaving the Overlay's interaction open.
 */
async function presentTurnMarks(input: {
  manager: OverlayWindowManager;
  cursorDisplayId: number;
  shapes: ParsedShape[];
  directive: PointDirective;
  geometry: DisplayCaptureGeometry[];
  screens: ScreenCaptureInput[];
  nativeCaptures: NativeScreenCapture[];
  scrollGenerationAtCapture: number;
  epochAtCompletion: number;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    manager,
    cursorDisplayId,
    shapes,
    directive,
    geometry,
    screens,
    nativeCaptures,
    scrollGenerationAtCapture,
    epochAtCompletion,
    signal,
  } = input;

  let effectiveShapes = shapes;
  let effectiveDirective = directive;
  try {
    const refineStartedAt = Date.now();
    const refined = await refineTurnMarks({ shapes, directive, geometry, nativeCaptures, signal });
    const refineElapsedMs = Date.now() - refineStartedAt;
    effectiveShapes = refined.shapes;
    effectiveDirective = refined.directive;

    // Fallback for the marks refinement didn't move (an unrefinable kind, a failed or
    // declined call): the local element snap, exactly as before refinement existed. A
    // refined mark is a new object, an untouched one is the original by reference.
    const snapImageFor = createSnapImageCache(screens, geometry);
    effectiveShapes = effectiveShapes.map((shape, index) => {
      if (shape !== shapes[index]) {
        return shape;
      }
      const snapImage = snapImageFor(shape.screenNumber);
      return snapImage === null ? shape : snapShapeToElement(shape, snapImage);
    });
    if (effectiveDirective.kind === "point" && effectiveDirective === directive) {
      const snapImage = snapImageFor(effectiveDirective.point.screenNumber);
      const snappedPoint =
        snapImage === null ? null : snapPointToElement(effectiveDirective.point, snapImage);
      if (snappedPoint !== null) {
        effectiveDirective = {
          kind: "point",
          point: { ...effectiveDirective.point, x: snappedPoint.x, y: snappedPoint.y },
        };
      }
    }

    // Always loud (one line per mark): the exact before/after of every drawn mark is
    // the difference between "it drew in the wrong place" being diagnosable from a
    // screenshot + console, or not. Marks are rare (a few per teaching turn at most).
    const captured = geometry.find((display) => display.screenNumber === 1);
    console.log(
      `[lune] marks: ${refined.refinedCount}/${shapes.length + (directive.kind === "point" ? 1 : 0)} ` +
        `vendor-refined in ${refineElapsedMs}ms ` +
        `(captured space ${captured?.capturedWidth}x${captured?.capturedHeight})`,
    );
    effectiveShapes.forEach((adjusted, index) => {
      const original = shapes[index]!;
      const wasRefined = refined.shapes[index] !== original;
      const how = wasRefined ? "refined" : adjusted !== original ? "snapped" : "unchanged";
      console.log(
        `[lune] mark: ${original.kind} "${original.label}" ` +
          `${JSON.stringify(original.points)} r=${original.radius} -> ${how} ` +
          `${JSON.stringify(adjusted.points)} r=${adjusted.radius}`,
      );
    });
    if (directive.kind === "point" && effectiveDirective.kind === "point") {
      const wasRefined = refined.directive !== directive;
      const how =
        wasRefined ? "refined" : effectiveDirective !== refined.directive ? "snapped" : "unchanged";
      console.log(
        `[lune] mark: point "${directive.point.label}" (${directive.point.x}, ${directive.point.y}) ` +
          `-> ${how} (${effectiveDirective.point.x}, ${effectiveDirective.point.y})`,
      );
    }
  } catch (error) {
    console.error("[lune] mark refinement failed; presenting unrefined marks:", error);
  }

  // Time passed while refining: only draw if this turn still owns the Overlay.
  if (signal?.aborted === true || teachingDrawingEpoch !== epochAtCompletion) {
    // The abort cleanup (or the newer answer) owns the Overlay's state now.
    return;
  }
  if (drawingScrollTracker.isStaleSince(scrollGenerationAtCapture)) {
    console.log("[lune] overlay: screen scrolled since capture; suppressing stale shapes/point");
    for (const message of planCompletionMessages({ kind: "none" }, geometry, cursorDisplayId)) {
      manager.sendToDisplay(message.displayId, message.event);
    }
    return;
  }

  for (const message of planCompletionMessages(effectiveDirective, geometry, cursorDisplayId)) {
    manager.sendToDisplay(message.displayId, message.event);
  }
  const shapeMessages = planShapeMessages(effectiveShapes, geometry);
  for (const message of shapeMessages) {
    manager.sendToDisplay(message.displayId, message.event);
  }
  if (shapeMessages.length > 0) {
    drawingScrollTracker.noteDrawingShown();
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
  // The advisory->act goal this turn carried, if any (parsed from the completed answer's
  // trailing [ACT: goal] tag). When present, the Screen Agent runs it after the advisory
  // answer, so the ordinary turn escalates to acting (DECISIONS #14).
  let actGoal: string | null = null;

  // The streaming-text toggle (ticket 13): read once at the turn's start so a change
  // takes effect on the next turn. When off, the Overlay cursor still flies and points,
  // but the answer text is not streamed into its response bubble (voice-only preference).
  const showStreamingText = settingsStore.getStreamingText();

  // Answer back instantly (the perceived-latency fix): a voice turn plays a short,
  // pre-synthesized acknowledgement the moment it starts - zero synthesis on the hot
  // path - so the ~2s of capture + reasoning + first-sentence synthesis never feels like
  // dead air. It rides this turn's id as sequence 0 (the real sentences start at 1), so
  // the answer's clips queue seamlessly behind it and a Barge-in's `stop` cuts it like
  // any other clip. Typed Chat Panel turns stay silent-until-answer as before.
  let fillerEmitted = false;
  if (inputMethod === "voice" && speechCapability?.isReady() === true && fillerClipCache !== null) {
    fillerClipCache.prime();
    const fillerClip = fillerClipCache.takeClip();
    if (fillerClip !== null && signal?.aborted !== true) {
      sendSpeechEvent({
        type: "clip",
        turnId,
        sequence: 0,
        audioBase64: fillerClip.audioBase64,
        contentType: fillerClip.contentType,
        // No caption: the filler is a beat, not answer content, and the thinking
        // spinner should stay up until the real first sentence speaks.
        text: "",
      });
      fillerEmitted = true;
    }
  }

  try {
    // Capture the screen(s) first (when opted in and permitted) so the answer is
    // screen-aware; with no captures this is exactly a text-only turn (and no pointing).
    const { screens, geometry, nativeCaptures } = await captureScreensForTurn(includeScreen);

    // Snapshot the scroll state the capture was taken under: the model's coordinates
    // are only meaningful against this exact screen, so a scroll before the answer
    // completes makes its shapes/point stale (they are suppressed at completion below).
    const scrollGenerationAtCapture = drawingScrollTracker.generation();

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
          // A new answer is beginning, so clear the previous turn's teaching drawing
          // everywhere it may still be up (the "next turn" clear of the shape lifecycle)
          // before this turn draws its own at completion. Bumping the epoch also stops
          // any previous turn's still-refining marks from drawing late.
          teachingDrawingEpoch += 1;
          overlayManager?.broadcast({ type: "clear-shapes" });
          drawingScrollTracker.noteDrawingCleared();
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
              // The instant filler already took sequence 0 of this turn.
              startSequence: fillerEmitted ? 1 : 0,
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
            // Strip all trailing tags (Act, then Point, then the Shape Tags before them) so
            // none ever flashes in the response bubble - only the spoken human text shows.
            const actStripped = parseAnswerActTag(accumulatedAnswer).displayText;
            const pointStripped = parseAnswerPointTag(actStripped).displayText;
            const { displayText } = parseAnswerShapeTags(pointStripped);
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
            // Peel the trailing tags off the completed answer in grammar order: the Act
            // Tag (the acting goal, if any), then the Point Tag, then the Shape Tags that
            // sit before them - so each is stripped from the display text, the acting goal
            // is captured, and the shapes are ready to draw.
            const { displayText: actStripped, actGoal: parsedActGoal } =
              parseAnswerActTag(accumulatedAnswer);
            actGoal = parsedActGoal;
            const { directive, displayText: pointStripped } = parseAnswerPointTag(actStripped);
            const { displayText, shapes } = parseAnswerShapeTags(pointStripped);
            // Dev-only (LUNE_REASONING_DEBUG): show the raw output and what the parsers made
            // of it, so a teaching turn that only spoke reveals whether the model even
            // emitted shape tags - and whether their coordinates land in the captured space.
            if (isReasoningDebugEnabled()) {
              const cursorScreen = geometry.find((display) => display.screenNumber === 1);
              console.log(
                formatReasoningCompletion({
                  rawAnswer: accumulatedAnswer,
                  shapes,
                  pointDirective: directive,
                  actGoal: parsedActGoal,
                  coordinateSpace: cursorScreen
                    ? { width: cursorScreen.capturedWidth, height: cursorScreen.capturedHeight }
                    : undefined,
                }),
              );
            }
            if (overlayManager && cursorDisplayId !== undefined) {
              // The full answer has streamed, so its trailing tags are now complete. The
              // pointing planner flies the cursor to the target on the correct monitor and
              // closes out; the shape planner draws the teaching shapes on their monitors.
              // Both keep the multi-monitor routing in one tested place. If the user
              // scrolled since this turn's capture, the coordinates aim at content that
              // has moved: suppress the flight and the drawing (the spoken answer still
              // plays) rather than mark the wrong pixels.
              const staleCapture = drawingScrollTracker.isStaleSince(scrollGenerationAtCapture);
              const hasMarks = shapes.length > 0 || directive.kind === "point";
              if (staleCapture || !hasMarks) {
                const effectiveDirective: PointDirective = staleCapture ? { kind: "none" } : directive;
                for (const message of planCompletionMessages(effectiveDirective, geometry, cursorDisplayId)) {
                  overlayManager.sendToDisplay(message.displayId, message.event);
                }
                if (staleCapture && hasMarks) {
                  console.log(
                    "[lune] overlay: screen scrolled since capture; suppressing stale shapes/point",
                  );
                }
              } else {
                // Marks exist and the capture is fresh: present them asynchronously (the
                // spoken answer keeps playing meanwhile) so the drawing-accuracy work can
                // wait on its Vendor calls without holding the turn.
                void presentTurnMarks({
                  manager: overlayManager,
                  cursorDisplayId,
                  shapes,
                  directive,
                  geometry,
                  screens,
                  nativeCaptures,
                  scrollGenerationAtCapture,
                  epochAtCompletion: teachingDrawingEpoch,
                  signal,
                });
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

    // The instant filler played but the turn never engaged real speech (readiness
    // flipped off before the answer started): close the turn out for the player, so it
    // settles to idle instead of holding "thinking" for clips that will never come.
    if (fillerEmitted && speechTurn === null) {
      sendSpeechEvent({ type: "turn-complete", turnId });
    }

    // The turn committed in the Core, so persist the active conversation's text-only
    // history (ticket 12) and tell the panel its recent-list may have changed. A failed
    // or aborted turn throws above and never reaches here, matching the Core's rollback.
    conversationHistoryStore.save(activeConversationId, conversationManager.getMessages());
    notifyConversationsChanged(webContents);

    // Advisory->act (DECISIONS #14): the answer asked Lune to actually do something on
    // screen, so hand the distilled goal to the Screen Agent now that the advisory answer
    // has been spoken. Awaited so the caller's Pill-idle bookkeeping covers the whole run
    // (the run speaks its own summary), and it shares this turn's barge-in signal.
    if (actGoal !== null) {
      // If the run queued speech, the same Kokoro-playback path a spoken turn uses owns the
      // Pill's return to idle; otherwise leave `spoke` as the advisory answer set it.
      const handoffSpoke = await runActHandoff(actGoal, signal);
      spoke = spoke || handoffSpoke;
    }
  } catch (error) {
    // Safety net: if the turn threw before the capture completed, following is still
    // suspended - resume it so the cursor doesn't stay frozen/hidden. Idempotent.
    overlayManager?.resumeFollowing();
    // End any Overlay interaction this turn opened so the cursor fades out rather than
    // hanging.
    if (overlayManager && overlayActive && cursorDisplayId !== undefined) {
      overlayManager.sendToDisplay(cursorDisplayId, { type: "activity-end" });
    }
    // Clear any teaching drawing at once: a Barge-in (the common abort) should wipe the
    // previous turn's shapes immediately rather than leave them until the timeout.
    overlayManager?.broadcast({ type: "clear-shapes" });
    drawingScrollTracker.noteDrawingCleared();
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
      // A genuine failure: log it in the main process (the renderer-facing error event
      // alone left upstream failures - a rejected model, a bad request - invisible in
      // every console), clear any audio already queued for this turn, and surface it.
      console.error("[lune] conversation turn failed:", error);
      if (speechTurn !== null || fillerEmitted) {
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
// Adding a key from Settings live-validates it (like onboarding) before storing, so a
// bad key gives instant, specific feedback rather than silently failing on the next turn.
ipcMain.handle(SETTINGS_VALIDATE_KEY_CHANNEL, async (_event, rawRequest: unknown) => {
  const request = ValidateKeyRequestSchema.parse(rawRequest);
  return ValidateKeyResponseSchema.parse(await requireSettingsService().validateAndSaveKey(request));
});
// List a Vendor's live models (using its stored key) for the Settings model picker, so
// the offered models track what the Vendor currently serves.
ipcMain.handle(SETTINGS_LIST_MODELS_CHANNEL, async (_event, rawRequest: unknown) => {
  const request = ListModelsRequestSchema.parse(rawRequest);
  return ListModelsResponseSchema.parse(await requireSettingsService().listModels(request.vendor));
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

// The cursor-riding intro video (M3-03): the welcome step toggles it on while it is showing
// and off when it advances or is skipped. The Shell owns display geometry, so it snapshots
// the onboarding window's bounds and hands the Overlay the card to ride, kept clear of the
// wizard. A `true` with the window already gone (a race on close) simply ends it.
ipcMain.on(ONBOARDING_SET_INTRO_VIDEO_CHANNEL, (_event, rawActive: unknown) => {
  const onboardingBounds = getOnboardingWindowBounds();
  if (rawActive === true && onboardingBounds !== null) {
    overlayManager?.startIntroVideo(onboardingBounds);
  } else {
    overlayManager?.endIntroVideo();
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

// The active conversation's current history, so the panel renders what is already going
// the moment it opens. A voice turn taken while the panel was closed is committed to the
// Core (and persisted) but never streamed to the panel's renderer, so without this the
// panel would open blank on top of a live conversation. A pure read: the active
// conversation is unchanged (unlike resume, this never switches which one is active).
ipcMain.handle(CONVERSATIONS_ACTIVE_CHANNEL, () =>
  ResumedConversationSchema.parse({
    activeId: activeConversationId,
    messages: conversationManager.getMessages(),
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
// supervisor. `exit` is the graceful-exit net (uncaught error, `process.exit`) where
// only synchronous work runs, so it SIGKILLs the child directly.
app.on("before-quit", () => {
  void transcription?.shutdown();
  // Release the global keyboard hook so the native uiohook thread stops cleanly (ticket 11).
  voiceController?.stop();
});
process.on("exit", () => {
  transcription?.killSync();
});

// Termination signals (`kill`, a dev Ctrl+C, a supervising launcher's SIGTERM) bypass
// Node's `exit` handlers entirely unless caught - so without this the child would
// outlive a signalled parent, exactly the orphaning we saw. Each handler SIGKILLs the
// child and releases the keyboard hook synchronously, then exits with the conventional
// 128+signal code (which re-runs the `exit` net harmlessly - `killSync` is idempotent).
// A parent SIGKILL still can't be intercepted, but the next launch reaps whatever it
// leaves behind (see `whisperOrphanReaper.ts`).
for (const terminationSignal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(terminationSignal, () => {
    transcription?.killSync();
    voiceController?.stop();
    process.exit(128 + osConstants.signals[terminationSignal]);
  });
}

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

  // The stale-drawing guard's input: global wheel (scroll) events from the shared uiohook
  // hook. Scrolling moves the content a teaching drawing was anchored to, so a scroll
  // clears a visible drawing at once and marks any in-flight turn's capture stale (its
  // shapes are then suppressed at completion). Rides the same native event tap as
  // push-to-talk; if the native hook is unavailable, drawings just rely on their
  // quiet-timeout as before.
  subscribeGlobalInput(() => ({
    wheel: () => {
      if (drawingScrollTracker.noteScroll()) {
        overlayManager?.broadcast({ type: "clear-shapes" });
      }
    },
  }));

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

  // Warm the instant-acknowledgement fillers as soon as Kokoro is ready, so the very
  // first voice turn already answers back instantly. `prime()` is a no-op until the
  // weights verify; each voice turn re-primes (cheaply), which also covers a Kokoro
  // that finishes provisioning after boot and a Voice changed in Settings.
  fillerClipCache = createFillerClipCache({
    speech: speechCapability,
    getVoiceId: () => routingConfigStore.getConfig().speech.voice,
    encodeBase64: (audio) => Buffer.from(audio).toString("base64"),
  });
  fillerClipCache.prime();

  // Synthetic input executor (M2-02): the Screen Agent's hands. Built over the nut.js
  // native backend + Electron clipboard, reusing the M1 Accessibility grant. No consumer
  // drives it yet (the Screen Agent loop is a later M2 ticket); the env-gated dev trigger
  // below is the only caller for now.
  syntheticInputExecutor = createDesktopSyntheticInputExecutor();

  // Screen Agent loop (M2-03): compose the Shell-driven agent loop over the real edges -
  // the Core step, the executor above, and the overlay-excluded scene capture (the overlay
  // manager suspends its own windows around each capture so Lune never photographs itself).
  // The confirm gate (M2-04, revised) is voice-only: it fires only before a consequential
  // (hard-to-undo) Action, speaks a plain-language line, and listens for a spoken yes/no via
  // push-to-talk (diverted to the gate so the answer never barges in the run). There is no
  // on-screen modal and no global approve/cancel hotkey - an explicit command is consent to
  // start, so a run no longer gates just to begin (DECISIONS #15, revised). `speak` uses the
  // same Kokoro path as a turn.
  screenAgentService = createScreenAgentService({
    capability: screenAgentCapability,
    executor: syntheticInputExecutor,
    // Assigned at the top of `whenReady`, above; non-null by the time the service is built.
    overlay: overlayManager!,
    // The AX target signal (M2-05) is deliberately NOT wired: its only implementation reads
    // the tree by driving System Events through `osascript`, which pops macOS's Automation
    // permission prompt - a fourth permission v1 never needed (v1 read AX natively via
    // `AXUIElementCopyElementAtPosition`, Accessibility-only). Rather than regress the
    // permission story, the target signal is omitted, so the Consequence floor gets no
    // AX-based click escalation. Confirm-to-start still gates the first OS touch, so a run
    // never begins acting unconfirmed. Re-enable behind a real native AX addon (no Apple
    // Events, no Automation prompt), the seam `axSignalProvider` was built for.
    // The cursor "acts the part" (M2-05): fly the playful Overlay cursor to each Action's
    // target before it executes, reusing the same `point` event the chat overlay flies on, so
    // the user sees where Lune is about to act and a gated Action shows the cursor waiting.
    overlayCursor: {
      pointCursorAt: (displayId, target) => {
        overlayManager?.sendToDisplay(displayId, {
          type: "point",
          point: { localX: target.localX, localY: target.localY, label: target.label },
        });
      },
      endPointing: (displayId) => {
        // End the interaction so the cursor flies back to the real mouse and resumes
        // following once the run is over (the same signal the chat overlay ends a turn with).
        overlayManager?.sendToDisplay(displayId, { type: "activity-end" });
      },
    } satisfies AgentCursorOverlay,
    speak: (text) => {
      void speakLine(text);
    },
    confirm: createConfirmGateController({
      speak: (text) => {
        void speakLine(text);
      },
      armAnswerCapture: (deliver) => {
        // Voice-only: push-to-talk answers the gate (hold to speak "yes"/"no") instead of
        // barging in the run the gate guards. There is no on-screen modal and no global
        // approve/cancel hotkey - a stray Enter in another app must never approve an
        // irreversible Action - so the spoken answer (plus the always-on barge-in cancel) is
        // the only way through. An ambiguous or unheard reply re-prompts and never proceeds.
        const offVoice =
          voiceController?.openConfirmGateCapture((transcript) =>
            deliver({ source: "voice", transcript }),
          ) ?? (() => {});
        return () => {
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
  // Key validation + live model listing are the cheap Core calls with the platform
  // `fetch` injected; the Settings service owns the validate-and-save-key flow the
  // onboarding key step also delegates to.
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
    validateKey: (vendorId, key) =>
      validateReasoningKey({
        vendor: findReasoningVendor(vendorId),
        apiKey: key,
        upstreamFetch: (url, requestInit) => fetch(url, requestInit),
      }),
    listModels: (vendorId, key) =>
      listReasoningModels({
        vendor: findReasoningVendor(vendorId),
        apiKey: key,
        upstreamFetch: (url, requestInit) => fetch(url, requestInit),
      }),
  });

  // Onboarding (ticket 14): now that the Settings service + Provisioning exist, wire the
  // service the onboarding IPC calls. The key step delegates validation to the Settings
  // service; the download is the one shared Provisioning run (started silently at the
  // welcome screen, resumed on a re-launched onboarding).
  onboardingService = createOnboardingService({
    settingsService,
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
