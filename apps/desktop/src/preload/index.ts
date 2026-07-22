import { contextBridge, ipcRenderer } from "electron";
import {
  PING_IPC_CHANNEL,
  type PingRequest,
  type PingResponse,
} from "@lune/shared";

// The typed bridge the renderer uses to reach the Core through the main process.
// It is deliberately tiny: the shared zod contract in @lune/shared is the single
// source of truth for message shape, so this file only forwards calls.
const luneBridge = {
  ping(pingRequest: PingRequest): Promise<PingResponse> {
    return ipcRenderer.invoke(PING_IPC_CHANNEL, pingRequest);
  },
};

contextBridge.exposeInMainWorld("lune", luneBridge);

export type LuneBridge = typeof luneBridge;
