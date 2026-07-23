import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  CHAT_EVENT_CHANNEL,
  CHAT_START_CHANNEL,
  ChatStreamEventSchema,
  type ChatStreamEvent,
  type ChatTurnRequest,
} from "@lune/shared";
import {
  APP_QUIT_CHANNEL,
  PILL_RESIZE_CHANNEL,
  PillContentSizeSchema,
  type PillContentSize,
} from "../ipc/pillControl";

// The typed bridge the renderer uses to reach the Core through the main process.
// It is deliberately tiny: the shared zod contract in @lune/shared is the single
// source of truth for message shape, so this file only starts turns and forwards
// validated streamed events. A chat reply is a stream, so the renderer starts a
// turn and subscribes to its events rather than awaiting a single value.
const luneBridge = {
  chat: {
    /** Starts one chat turn; its streamed events arrive via {@link onChatEvent}. */
    start(chatTurnRequest: ChatTurnRequest): void {
      ipcRenderer.send(CHAT_START_CHANNEL, chatTurnRequest);
    },
    /**
     * Subscribes to every streamed chat event, validating each against the shared
     * contract before handing it to the renderer (no untyped shape crosses in).
     * Returns an unsubscribe function.
     */
    onChatEvent(listener: (event: ChatStreamEvent) => void): () => void {
      const forwardValidatedEvent = (_event: IpcRendererEvent, rawEvent: unknown): void => {
        const parsedEvent = ChatStreamEventSchema.safeParse(rawEvent);
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
};

contextBridge.exposeInMainWorld("lune", luneBridge);

export type LuneBridge = typeof luneBridge;
