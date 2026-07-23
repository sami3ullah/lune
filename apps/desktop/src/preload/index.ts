import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
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
  OVERLAY_EVENT_CHANNEL,
  OVERLAY_IDLE_CHANNEL,
  OverlayEventSchema,
  type OverlayEvent,
} from "../ipc/overlayControl";
import {
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
  },
};

contextBridge.exposeInMainWorld("lune", luneBridge);

export type LuneBridge = typeof luneBridge;
