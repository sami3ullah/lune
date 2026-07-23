import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type { ChildRuntimeGateway, ChildRuntimeId, TranscribeAudio, TranscriptionResult } from "@lune/core";

/**
 * The real Node-backed whisper.cpp child Runtime (ADR-0003), ported from v1's
 * `nodeWhisperRuntime.ts`: it runs `whisper-server` (large-v3-turbo, Metal) as a
 * supervised child process on a local port, and the Core's Transcription Capability
 * hands each recorded clip to it through the injected `transcribe` seam.
 *
 * This lives in the Electron main process, never in @lune/core (developer story 45):
 * the Core defines the `ChildRuntimeGateway` + `TranscribeAudio` seams and all the
 * supervision/readiness logic above them; this file is the thin platform edge - the
 * actual process spawn, health check, and HTTP call - so it has no unit tests of its
 * own (the logic above it is tested against stubs). The binary is built from pinned
 * source (`scripts/build-whisper-server.sh`) and the weights come from Provisioning
 * (ticket 08); until both exist `start` fails and the supervisor reports the Runtime
 * "not ready", so transcription throws not-ready rather than hanging.
 */

/** Local port the whisper-server child listens on (kept off any app port). */
const WHISPER_SERVER_PORT = 8771;
const WHISPER_SERVER_BASE_URL = `http://127.0.0.1:${WHISPER_SERVER_PORT}`;

/** How long to wait for whisper-server to start listening before giving up. */
const STARTUP_HEALTH_TIMEOUT_MS = 15_000;
/** How often to poll `/health` while waiting for startup. */
const STARTUP_HEALTH_POLL_INTERVAL_MS = 250;
/** Per-request timeout for a single `/health` probe, so a hung socket never blocks. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
/** Per-request timeout for one transcription, so a wedged Runtime surfaces as an error. */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

export interface NodeWhisperRuntimeOptions {
  /** Absolute path to the whisper-server binary (built from pinned source, ticket 10). */
  serverBinaryPath: string;
  /** Absolute path to the provisioned whisper model weights. */
  modelPath: string;
}

/**
 * Builds the whisper child-Runtime gateway plus the transcribe call, and a synchronous
 * `killSync` used on abrupt process exit so no whisper-server is ever orphaned. The
 * gateway only handles `whisper` (Lune's one child Runtime).
 */
export function createNodeWhisperRuntime(options: NodeWhisperRuntimeOptions): {
  gateway: ChildRuntimeGateway;
  transcribe: TranscribeAudio;
  killSync: () => void;
} {
  let whisperProcess: ChildProcess | undefined;

  const gateway: ChildRuntimeGateway = {
    async start(runtimeId: ChildRuntimeId): Promise<void> {
      if (runtimeId !== "whisper") {
        throw new Error(`nodeWhisperRuntime does not manage the ${runtimeId} Runtime`);
      }
      if (whisperProcess !== undefined && whisperProcess.exitCode === null) {
        return; // already running
      }
      const child = spawn(
        options.serverBinaryPath,
        ["--model", options.modelPath, "--port", String(WHISPER_SERVER_PORT), "--host", "127.0.0.1"],
        { stdio: "ignore" },
      );
      whisperProcess = child;
      child.on("error", (error) => {
        console.error("[runtime:whisper] process error:", error);
      });
      // Clear the reference only when *this* child actually exits (guarded against a
      // newer child having replaced it). `stop` deliberately does not null the
      // reference - it must survive a SIGTERM the child might ignore so `killSync`
      // can still SIGKILL it on abrupt exit, so nothing is ever orphaned (ticket 10).
      child.on("exit", () => {
        if (whisperProcess === child) {
          whisperProcess = undefined;
        }
      });

      // `spawn` returns before the server is listening, so wait (bounded) for it to
      // answer `/health` before resolving. Without this the supervisor would
      // health-check an unbound port and immediately mark the Runtime "failed".
      // Throwing on timeout lets the supervisor record the failure legibly.
      await waitUntilHealthy();
    },

    async stop(runtimeId: ChildRuntimeId): Promise<void> {
      if (runtimeId !== "whisper" || whisperProcess === undefined) {
        return;
      }
      // Graceful stop: request termination but keep the reference so `killSync` can
      // escalate to SIGKILL if the child ignores SIGTERM (the exit listener clears
      // the reference once it truly dies).
      whisperProcess.kill("SIGTERM");
    },

    async isHealthy(runtimeId: ChildRuntimeId): Promise<boolean> {
      if (runtimeId !== "whisper") {
        return false;
      }
      return probeHealth();
    },
  };

  /** A single `/health` probe with a timeout so a hung socket can't block. */
  async function probeHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${WHISPER_SERVER_BASE_URL}/health`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Polls `/health` until it passes or the startup budget is exhausted (then throws). */
  async function waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
    for (;;) {
      if (await probeHealth()) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("whisper-server did not become healthy within the startup timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, STARTUP_HEALTH_POLL_INTERVAL_MS));
    }
  }

  const transcribe: TranscribeAudio = async (audioWav: Uint8Array): Promise<TranscriptionResult> => {
    // whisper-server accepts the audio file as multipart form data on /inference.
    // Copy into a fresh ArrayBuffer-backed view so it is an unambiguous BlobPart.
    const audioBlobPart = new Uint8Array(audioWav);
    const form = new FormData();
    form.append("file", new Blob([audioBlobPart], { type: "audio/wav" }), "clip.wav");
    form.append("response_format", "json");

    const response = await fetch(`${WHISPER_SERVER_BASE_URL}/inference`, {
      method: "POST",
      body: form,
      // Bounded so a wedged Runtime surfaces as an error instead of hanging the
      // Shell's push-to-talk release.
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`whisper-server transcription failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { text?: unknown };
    return { text: typeof payload.text === "string" ? payload.text.trim() : "" };
  };

  // Synchronous, best-effort kill for the abrupt-exit path (`process.on("exit")`),
  // where only synchronous work runs: SIGKILL the child immediately so a crashed or
  // hard-exited main process never leaves whisper-server behind (ticket 10 acceptance).
  const killSync = (): void => {
    if (whisperProcess !== undefined && whisperProcess.exitCode === null) {
      whisperProcess.kill("SIGKILL");
      whisperProcess = undefined;
    }
  };

  return { gateway, transcribe, killSync };
}

/** Default whisper model path inside the managed models directory (matches the manifest). */
export function defaultWhisperModelPath(modelsDirectoryPath: string): string {
  return path.join(modelsDirectoryPath, "whisper", "ggml-large-v3-turbo.bin");
}
