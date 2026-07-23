import path from "node:path";

/**
 * Resolves where the whisper-server binary lives (ticket 15). whisper.cpp ships as
 * source only, so Lune builds the binary from pinned source and *bundles* it in the app
 * rather than downloading it (only the weights are provisioned). The installed app finds
 * it in its Resources directory; dev/tests point at a locally-built copy via an env
 * override. This is pure path logic (no fs, no Electron), so it is unit-tested directly.
 */

/** The file name the packaged whisper-server binary is staged under (electron-builder `extraResources`). */
export const WHISPER_SERVER_RESOURCE_NAME = "whisper-server";

/** The dev/escape-hatch env var pointing at a locally-built whisper-server binary. */
export const WHISPER_SERVER_PATH_ENV = "LUNE_WHISPER_SERVER_PATH";

export interface WhisperServerBinaryPathInput {
  /** Whether the app is running from a packaged bundle (`app.isPackaged`). */
  isPackaged: boolean;
  /** The bundle's Resources directory (`process.resourcesPath`); where `extraResources` land. */
  resourcesPath: string;
  /** The raw `LUNE_WHISPER_SERVER_PATH` value, if set. */
  envOverride: string | undefined;
}

/**
 * The whisper-server binary path, or `undefined` when none is available (so Transcription
 * reports not-ready rather than hanging). Resolution order:
 *   1. The env override, if set and non-blank - lets dev (and a packaged debug session)
 *      point at a locally-built binary, matching how tickets 10-14 ran it in dev.
 *   2. The bundled resource, when packaged - the normal installed-app path.
 *   3. Otherwise nothing - a dev launch that never built the binary.
 */
export function resolveWhisperServerBinaryPath(input: WhisperServerBinaryPathInput): string | undefined {
  const override = input.envOverride?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }
  if (input.isPackaged) {
    return path.join(input.resourcesPath, WHISPER_SERVER_RESOURCE_NAME);
  }
  return undefined;
}
