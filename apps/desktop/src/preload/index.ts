import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { z } from "zod";
import {
  CHAT_EVENT_CHANNEL,
  CHAT_START_CHANNEL,
  ConversationStreamEventSchema,
  type ConversationStreamEvent,
  type ChatTurnRequest,
} from "@lune/shared";
import {
  APP_QUIT_CHANNEL,
  PILL_RESIZE_CHANNEL,
  PillContentSizeSchema,
  type PillContentSize,
} from "../ipc/pillControl";
import { CHAT_PANEL_TOGGLE_CHANNEL } from "../ipc/chatPanel";
import {
  CONVERSATIONS_CHANGED_CHANNEL,
  CONVERSATIONS_LIST_CHANNEL,
  CONVERSATIONS_NEW_CHANNEL,
  CONVERSATIONS_RESUME_CHANNEL,
  ConversationListSnapshotSchema,
  ResumedConversationSchema,
  type ConversationListSnapshotValue,
  type ResumedConversationValue,
} from "../ipc/conversations";
import {
  SETTINGS_GET_CHANNEL,
  SETTINGS_READINESS_CHANNEL,
  SETTINGS_REPAIR_CHANNEL,
  SETTINGS_SAVE_CHANNEL,
  SETTINGS_SET_KEY_CHANNEL,
  SETTINGS_TOGGLE_CHANNEL,
  ReadinessRowSchema,
  SettingsSnapshotSchema,
  SettingsStateSchema,
  type ReadinessRow,
  type SetApiKeyRequest,
  type SettingsSnapshot,
  type SettingsState,
  type SettingsValues,
} from "../ipc/settings";
import {
  OVERLAY_EVENT_CHANNEL,
  OVERLAY_IDLE_CHANNEL,
  OverlayEventSchema,
  type OverlayEvent,
} from "../ipc/overlayControl";
import {
  SCREEN_OPEN_SETTINGS_CHANNEL,
  SCREEN_PERMISSION_REQUEST_CHANNEL,
  SCREEN_PERMISSION_STATUS_CHANNEL,
  SCREEN_RELAUNCH_CHANNEL,
  ScreenPermissionStateSchema,
  type ScreenPermissionStateValue,
} from "../ipc/screenPermission";
import {
  SPEECH_EVENT_CHANNEL,
  SpeechEventSchema,
  type SpeechEvent,
} from "../ipc/speechPlayback";
import {
  MIC_OPEN_SETTINGS_CHANNEL,
  MIC_PERMISSION_REQUEST_CHANNEL,
  MIC_PERMISSION_STATUS_CHANNEL,
  MicPermissionStateSchema,
  type MicPermissionStateValue,
} from "../ipc/micPermission";
import {
  VOICE_PILL_ACTIVITY_CHANNEL,
  VOICE_RECORD_COMMAND_CHANNEL,
  VOICE_RECORD_EVENT_CHANNEL,
  VoicePillActivitySchema,
  VoiceRecordCommandSchema,
  VoiceRecordEventSchema,
  type VoicePillActivity,
  type VoiceRecordCommand,
  type VoiceRecordEvent,
} from "../ipc/voiceInput";
import {
  ONBOARDING_COMPLETE_CHANNEL,
  ONBOARDING_DOWNLOAD_STATUS_CHANNEL,
  ONBOARDING_OPEN_GET_KEY_CHANNEL,
  ONBOARDING_START_DOWNLOAD_CHANNEL,
  ONBOARDING_VALIDATE_KEY_CHANNEL,
  OnboardingDownloadStatusSchema,
  ValidateKeyResponseSchema,
  type OnboardingDownloadStatusValue,
  type ValidateKeyRequest,
  type ValidateKeyResponse,
} from "../ipc/onboarding";
import type { SettingsVendorId } from "../ipc/settings";

// The typed bridge the renderer uses to reach the Core through the main process.
// It is deliberately tiny: the shared zod contract in @lune/shared is the single
// source of truth for message shape, so this file only starts turns and forwards
// validated streamed events. A chat reply is a stream, so the renderer starts a
// turn and subscribes to its events rather than awaiting a single value.
const luneBridge = {
  chat: {
    /** Starts one conversation turn; its streamed events arrive via {@link onChatEvent}. */
    start(chatTurnRequest: ChatTurnRequest): void {
      ipcRenderer.send(CHAT_START_CHANNEL, chatTurnRequest);
    },
    /**
     * Subscribes to every streamed conversation event, validating each against the
     * shared contract before handing it to the renderer (no untyped shape crosses in).
     * Returns an unsubscribe function.
     */
    onChatEvent(listener: (event: ConversationStreamEvent) => void): () => void {
      const forwardValidatedEvent = (_event: IpcRendererEvent, rawEvent: unknown): void => {
        const parsedEvent = ConversationStreamEventSchema.safeParse(rawEvent);
        if (parsedEvent.success) {
          listener(parsedEvent.data);
        } else {
          console.error("[lune] dropping malformed chat event:", parsedEvent.error.message);
        }
      };
      ipcRenderer.on(CHAT_EVENT_CHANNEL, forwardValidatedEvent);
      return () => ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, forwardValidatedEvent);
    },
  },
  chatPanel: {
    /** Opens the Chat Panel window, or hides it if already open. */
    toggle(): void {
      ipcRenderer.send(CHAT_PANEL_TOGGLE_CHANNEL);
    },
  },
  settings: {
    /** Opens the Settings window, or hides it if already open. */
    toggle(): void {
      ipcRenderer.send(SETTINGS_TOGGLE_CHANNEL);
    },
    /** Reads the full Settings snapshot (static catalog + live state) on open. */
    async get(): Promise<SettingsSnapshot> {
      return SettingsSnapshotSchema.parse(await ipcRenderer.invoke(SETTINGS_GET_CHANNEL));
    },
    /** Persists edited Vendor/Model/Voice/hotkey/streaming values; resolves with new state. */
    async save(values: SettingsValues): Promise<SettingsState> {
      return SettingsStateSchema.parse(await ipcRenderer.invoke(SETTINGS_SAVE_CHANNEL, values));
    },
    /** Sets (non-empty) or clears (empty) one Vendor's API key; resolves with new state. */
    async setKey(request: SetApiKeyRequest): Promise<SettingsState> {
      return SettingsStateSchema.parse(await ipcRenderer.invoke(SETTINGS_SET_KEY_CHANNEL, request));
    },
    /** Re-runs/repairs Provisioning; resolves with the state (readiness reflects the run). */
    async repair(): Promise<SettingsState> {
      return SettingsStateSchema.parse(await ipcRenderer.invoke(SETTINGS_REPAIR_CHANNEL));
    },
    /** Reads just the live readiness rows, for polling the download percentage. */
    async readiness(): Promise<ReadinessRow[]> {
      return ReadinessRowSchema.array().parse(await ipcRenderer.invoke(SETTINGS_READINESS_CHANNEL));
    },
  },
  conversations: {
    /**
     * Reads the recent-conversations list and the active id for the dropdown, validated
     * against the shared codec before the renderer sees it (no untyped shape crosses in).
     */
    async list(): Promise<ConversationListSnapshotValue> {
      return ConversationListSnapshotSchema.parse(await ipcRenderer.invoke(CONVERSATIONS_LIST_CHANNEL));
    },
    /**
     * Resumes a stored conversation by id, resolving with its full text history to
     * render (the main process seeds the Core and makes it active). The next turn
     * answers with fresh screen context - screenshots were never stored.
     */
    async resume(id: string): Promise<ResumedConversationValue> {
      return ResumedConversationSchema.parse(await ipcRenderer.invoke(CONVERSATIONS_RESUME_CHANNEL, id));
    },
    /** Starts a new, empty conversation, resolving with its freshly-minted active id. */
    async startNew(): Promise<{ activeId: string }> {
      const activeId = z.string().min(1).parse(await ipcRenderer.invoke(CONVERSATIONS_NEW_CHANNEL));
      return { activeId };
    },
    /**
     * Subscribes to "the persisted set changed" notifications (a turn added, renamed,
     * or pruned a conversation) so the panel can refresh its dropdown. Returns an
     * unsubscribe function.
     */
    onChanged(listener: () => void): () => void {
      const forward = (): void => listener();
      ipcRenderer.on(CONVERSATIONS_CHANGED_CHANNEL, forward);
      return () => ipcRenderer.removeListener(CONVERSATIONS_CHANGED_CHANNEL, forward);
    },
  },
  overlay: {
    /**
     * Subscribes to the Overlay events for this window (activity, streamed answer
     * text, a pointing target), validating each against the shared codec before it
     * drives the cursor. Returns an unsubscribe function. Used only by the Overlay
     * surface; the Pill window never subscribes.
     */
    onOverlayEvent(listener: (event: OverlayEvent) => void): () => void {
      const forwardValidatedEvent = (_event: IpcRendererEvent, rawEvent: unknown): void => {
        const parsedEvent = OverlayEventSchema.safeParse(rawEvent);
        if (parsedEvent.success) {
          listener(parsedEvent.data);
        } else {
          console.error("[lune] dropping malformed overlay event:", parsedEvent.error.message);
        }
      };
      ipcRenderer.on(OVERLAY_EVENT_CHANNEL, forwardValidatedEvent);
      return () => ipcRenderer.removeListener(OVERLAY_EVENT_CHANNEL, forwardValidatedEvent);
    },
    /** Tells the main process this Overlay has faded out and its window can be hidden. */
    signalIdle(): void {
      ipcRenderer.send(OVERLAY_IDLE_CHANNEL);
    },
  },
  speech: {
    /**
     * Subscribes to Kokoro speech-playback events (synthesized clips, turn-complete,
     * stop), validating each against the shared codec before the renderer plays it.
     * Only the Pill renderer subscribes - it owns Lune's audio output. Returns an
     * unsubscribe function.
     */
    onSpeechEvent(listener: (event: SpeechEvent) => void): () => void {
      const forwardValidatedEvent = (_event: IpcRendererEvent, rawEvent: unknown): void => {
        const parsedEvent = SpeechEventSchema.safeParse(rawEvent);
        if (parsedEvent.success) {
          listener(parsedEvent.data);
        } else {
          console.error("[lune] dropping malformed speech event:", parsedEvent.error.message);
        }
      };
      ipcRenderer.on(SPEECH_EVENT_CHANNEL, forwardValidatedEvent);
      return () => ipcRenderer.removeListener(SPEECH_EVENT_CHANNEL, forwardValidatedEvent);
    },
  },
  voice: {
    /**
     * Subscribes the Pill to recording commands from the main process (the hotkey
     * drives start/stop/cancel). Only the Pill renderer subscribes - it owns the mic
     * (and audio output). Each command is validated before the renderer acts on it.
     * Returns an unsubscribe function.
     */
    onRecordCommand(listener: (command: VoiceRecordCommand) => void): () => void {
      const forwardValidatedCommand = (_event: IpcRendererEvent, rawCommand: unknown): void => {
        const parsedCommand = VoiceRecordCommandSchema.safeParse(rawCommand);
        if (parsedCommand.success) {
          listener(parsedCommand.data);
        } else {
          console.error("[lune] dropping malformed voice record command:", parsedCommand.error.message);
        }
      };
      ipcRenderer.on(VOICE_RECORD_COMMAND_CHANNEL, forwardValidatedCommand);
      return () => ipcRenderer.removeListener(VOICE_RECORD_COMMAND_CHANNEL, forwardValidatedCommand);
    },
    /**
     * Sends one recording event (live level, finished clip, or error) to the main
     * process, validated against the shared codec on the way out so no untyped shape
     * crosses the boundary.
     */
    sendRecordEvent(event: VoiceRecordEvent): void {
      ipcRenderer.send(VOICE_RECORD_EVENT_CHANNEL, VoiceRecordEventSchema.parse(event));
    },
    /**
     * Subscribes to the voice-loop activity state (idle/listening/thinking) the main
     * process pushes so the Pill's indicator reflects the loop live. Returns an
     * unsubscribe function. (Speaking is driven separately by Kokoro playback.)
     */
    onPillActivity(listener: (activity: VoicePillActivity) => void): () => void {
      const forwardValidatedActivity = (_event: IpcRendererEvent, rawActivity: unknown): void => {
        const parsedActivity = VoicePillActivitySchema.safeParse(rawActivity);
        if (parsedActivity.success) {
          listener(parsedActivity.data);
        } else {
          console.error("[lune] dropping malformed pill activity:", parsedActivity.error.message);
        }
      };
      ipcRenderer.on(VOICE_PILL_ACTIVITY_CHANNEL, forwardValidatedActivity);
      return () => ipcRenderer.removeListener(VOICE_PILL_ACTIVITY_CHANNEL, forwardValidatedActivity);
    },
    /** Reads the current mic-permission state without prompting (for live polling). */
    async getMicPermissionStatus(): Promise<MicPermissionStateValue> {
      return MicPermissionStateSchema.parse(await ipcRenderer.invoke(MIC_PERMISSION_STATUS_CHANNEL));
    },
    /** Requests mic access, popping the OS prompt on the first attempt; resolves to the state. */
    async requestMicPermission(): Promise<MicPermissionStateValue> {
      return MicPermissionStateSchema.parse(await ipcRenderer.invoke(MIC_PERMISSION_REQUEST_CHANNEL));
    },
    /** Opens System Settings to the Microphone pane (for the denied case, which never re-prompts). */
    openMicSettings(): void {
      ipcRenderer.send(MIC_OPEN_SETTINGS_CHANNEL);
    },
  },
  pill: {
    /**
     * Reports the pill's current rendered content size so the main process can
     * resize the frameless window to match exactly (no dead click-catching region
     * around the pill). Validated against the shared codec before it leaves the
     * renderer so a bad measurement never crosses the boundary.
     */
    reportContentSize(contentSize: PillContentSize): void {
      ipcRenderer.send(PILL_RESIZE_CHANNEL, PillContentSizeSchema.parse(contentSize));
    },
    /** Quits Lune from the pill menu; the main process tears everything down cleanly. */
    quit(): void {
      ipcRenderer.send(APP_QUIT_CHANNEL);
    },
  },
  screen: {
    /**
     * Reads the current screen-recording permission state without prompting, so the
     * renderer can poll it for live status. Each result is validated against the
     * shared codec before the renderer sees it.
     */
    async getPermissionStatus(): Promise<ScreenPermissionStateValue> {
      return ScreenPermissionStateSchema.parse(
        await ipcRenderer.invoke(SCREEN_PERMISSION_STATUS_CHANNEL),
      );
    },
    /**
     * Requests screen-recording access by attempting a capture - this is what pops
     * the macOS permission prompt on the first attempt. Resolves to the resulting
     * validated state (granted / denied / needs-relaunch).
     */
    async requestPermission(): Promise<ScreenPermissionStateValue> {
      return ScreenPermissionStateSchema.parse(
        await ipcRenderer.invoke(SCREEN_PERMISSION_REQUEST_CHANNEL),
      );
    },
    /** Relaunches Lune so a freshly-granted permission takes effect (macOS quirk). */
    relaunch(): void {
      ipcRenderer.send(SCREEN_RELAUNCH_CHANNEL);
    },
    /** Opens System Settings to the Screen Recording pane (for the denied case, which never re-prompts). */
    openSettings(): void {
      ipcRenderer.send(SCREEN_OPEN_SETTINGS_CHANNEL);
    },
  },
  onboarding: {
    /**
     * Live-validates a candidate Vendor key with a cheap test call and, on success,
     * stores it (routing the Vendor if the currently-routed one has no key). Resolves
     * with the verdict and the resulting Settings state, validated against the shared
     * codec before the renderer sees it (no untyped shape crosses in).
     */
    async validateKey(request: ValidateKeyRequest): Promise<ValidateKeyResponse> {
      return ValidateKeyResponseSchema.parse(
        await ipcRenderer.invoke(ONBOARDING_VALIDATE_KEY_CHANNEL, request),
      );
    },
    /** Starts (or resumes) the background model download; idempotent. */
    startDownload(): void {
      ipcRenderer.send(ONBOARDING_START_DOWNLOAD_CHANNEL);
    },
    /** Reads the download step's live progress / preflight state. */
    async downloadStatus(): Promise<OnboardingDownloadStatusValue> {
      return OnboardingDownloadStatusSchema.parse(
        await ipcRenderer.invoke(ONBOARDING_DOWNLOAD_STATUS_CHANNEL),
      );
    },
    /** Marks onboarding complete and closes the window. */
    complete(): void {
      ipcRenderer.send(ONBOARDING_COMPLETE_CHANNEL);
    },
    /** Opens one Vendor's "get a key" page in the default browser. */
    openGetKeyLink(vendor: SettingsVendorId): void {
      ipcRenderer.send(ONBOARDING_OPEN_GET_KEY_CHANNEL, vendor);
    },
  },
};

contextBridge.exposeInMainWorld("lune", luneBridge);

export type LuneBridge = typeof luneBridge;
