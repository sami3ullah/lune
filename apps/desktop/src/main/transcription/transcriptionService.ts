import { readFile } from "node:fs/promises";

import {
  ChildRuntimeSupervisor,
  createTranscriptionCapability,
  type ChildRuntimeGateway,
  type ChildRuntimeId,
  type TranscribeAudio,
  type TranscriptionCapability,
} from "@lune/core";
import { createNodeWhisperRuntime, defaultWhisperModelPath } from "./nodeWhisperRuntime";

/**
 * Wires the Core's Transcription Capability + child-Runtime supervisor to the real
 * Node whisper.cpp edge for the Electron main process (ticket 10). The Core owns all
 * the supervision, readiness, and batch-transcribe logic; this only injects the
 * platform edge (the whisper-server spawn/health/HTTP call) and the reconcile +
 * teardown lifecycle the app drives.
 *
 * Two things must both hold before transcription is ready (ADR-0003, ADR-0006): the
 * whisper weights must be provisioned, and the whisper child Runtime must be started
 * and healthy. In dev the whisper-server binary is only present once built from
 * pinned source (`scripts/build-whisper-server.sh`) and pointed at via
 * `LUNE_WHISPER_SERVER_PATH`; absent, whisper is never started and transcription
 * simply reports not-ready (never hangs).
 */

/** The whisper-server binary path (dev override); absent → whisper reports not-ready. */
const WHISPER_SERVER_PATH_ENV = "LUNE_WHISPER_SERVER_PATH";

/** A dev-only WAV file the transcribe dev trigger feeds through the Core API (acceptance #1). */
const TRANSCRIBE_WAV_PATH_ENV = "LUNE_TRANSCRIBE_WAV_PATH";

/** The whisper child Runtime id, as a single-element desired set for reconcile. */
const WHISPER_DESIRED: ReadonlySet<ChildRuntimeId> = new Set<ChildRuntimeId>(["whisper"]);
const NONE_DESIRED: ReadonlySet<ChildRuntimeId> = new Set<ChildRuntimeId>();

/** Explains why transcription is unavailable in dev when no whisper-server binary is built. */
const WHISPER_BINARY_NOT_CONFIGURED = "whisper-server binary is not configured";

export interface DesktopTranscription {
  capability: TranscriptionCapability;
  supervisor: ChildRuntimeSupervisor;
  /**
   * Reconciles the whisper child Runtime to running iff it can actually run - the
   * binary is configured AND the weights are provisioned. Safe to call repeatedly
   * (idempotent) as provisioning completes or the config changes.
   */
  reconcile(): Promise<void>;
  /** Async teardown of the whisper child (normal quit): SIGTERM via the supervisor. */
  shutdown(): Promise<void>;
  /** Synchronous, best-effort kill for the abrupt-exit path so nothing is orphaned. */
  killSync(): void;
}

export interface DesktopTranscriptionOptions {
  /** The one Lune-managed models directory the whisper weights live under. */
  modelsDirectoryPath: string;
  /** Whether the whisper weights are currently provisioned + verified (from Provisioning). */
  isWhisperProvisioned: () => boolean;
  /** The whisper-server binary path; defaults to `LUNE_WHISPER_SERVER_PATH` (absent in dev). */
  whisperServerBinaryPath?: string;
}

/** Builds the Transcription Capability over the real whisper edge, if the binary is configured. */
export function createDesktopTranscription(options: DesktopTranscriptionOptions): DesktopTranscription {
  const binaryPath = resolveTrimmedPath(options.whisperServerBinaryPath ?? process.env[WHISPER_SERVER_PATH_ENV]);
  const modelPath = defaultWhisperModelPath(options.modelsDirectoryPath);

  let killSync = (): void => {};
  let gateway: ChildRuntimeGateway;
  let transcribe: TranscribeAudio;

  if (binaryPath !== undefined) {
    const runtime = createNodeWhisperRuntime({ serverBinaryPath: binaryPath, modelPath });
    gateway = runtime.gateway;
    transcribe = runtime.transcribe;
    killSync = runtime.killSync;
  } else {
    // No whisper-server binary built yet (typical in dev before ticket 15 packaging):
    // whisper is never desired, so this gateway is never driven - but it stays safe.
    gateway = notConfiguredWhisperGateway();
    transcribe = async () => {
      throw new Error(WHISPER_BINARY_NOT_CONFIGURED);
    };
  }

  const supervisor = new ChildRuntimeSupervisor(gateway);

  // Readiness is the conjunction the issue defines: weights provisioned AND child healthy.
  // `isReady` reads the supervisor's cached state (set at reconcile/refreshHealth), so a
  // child that *dies after* becoming ready is caught on the next reconcile/health refresh
  // rather than instantly - matching v1's readiness. Until the push-to-talk caller lands
  // (ticket 11), a stale-ready transcribe simply rejects with the Runtime's error.
  const isRuntimeReady = () => options.isWhisperProvisioned() && supervisor.isReady("whisper");
  const capability = createTranscriptionCapability({ isRuntimeReady, transcribe });

  async function reconcile(): Promise<void> {
    const canRun = binaryPath !== undefined && options.isWhisperProvisioned();
    await supervisor.reconcile(canRun ? WHISPER_DESIRED : NONE_DESIRED);
  }

  async function shutdown(): Promise<void> {
    await supervisor.stopAll();
  }

  return { capability, supervisor, reconcile, shutdown, killSync };
}

/**
 * The dev trigger (env-gated on `LUNE_TRANSCRIBE_WAV_PATH`) that exercises ticket 10's
 * first acceptance before the push-to-talk voice loop exists (ticket 11): it feeds a
 * recorded WAV file straight through the Core Transcription API and logs the
 * transcript. A no-op when the env var is absent, so a normal launch does nothing.
 *
 * @returns whether a transcription was actually attempted.
 */
export async function runTranscriptionDevTrigger(
  transcription: DesktopTranscription,
  log: (message: string) => void = (message) => console.log(`[lune] ${message}`),
): Promise<boolean> {
  const wavPath = resolveTrimmedPath(process.env[TRANSCRIBE_WAV_PATH_ENV]);
  if (wavPath === undefined) {
    return false;
  }

  if (!transcription.capability.isReady()) {
    log(
      `transcription dev trigger: whisper not ready (needs provisioned weights + ${WHISPER_SERVER_PATH_ENV})`,
    );
    return false;
  }

  log(`transcription dev trigger: transcribing ${wavPath} via the Core API`);
  const audioWav = await readFile(wavPath);
  const result = await transcription.capability.transcribe(new Uint8Array(audioWav));
  log(`transcription dev trigger: transcript = ${JSON.stringify(result.text)}`);
  return true;
}

/** Trims and normalises a possibly-empty path env value to `undefined` when blank. */
function resolveTrimmedPath(rawPath: string | undefined): string | undefined {
  if (rawPath === undefined) {
    return undefined;
  }
  const trimmed = rawPath.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A gateway used when no whisper-server binary is configured; never actually driven. */
function notConfiguredWhisperGateway(): ChildRuntimeGateway {
  return {
    async start(): Promise<void> {
      throw new Error(WHISPER_BINARY_NOT_CONFIGURED);
    },
    async stop(): Promise<void> {},
    async isHealthy(): Promise<boolean> {
      return false;
    },
  };
}
