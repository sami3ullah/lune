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
  /**
   * A locally-built binary to fall back to in a dev (unpackaged) launch - the repo's
   * `build/whisper-server`, the exact copy `scripts/package-dmg.sh` stages into the
   * bundle. Used only when it actually exists on disk (`fileExists`), so a dev who has
   * built the binary gets working transcription with no env var to remember, while a
   * dev who hasn't still reports not-ready rather than spawning a missing file.
   */
  devFallbackBinaryPath?: string;
  /**
   * Existence probe for {@link devFallbackBinaryPath}, injected so this stays pure and
   * unit-testable (the impure fs check lives in the caller). Absent → no dev fallback.
   */
  fileExists?: (candidatePath: string) => boolean;
}

/**
 * The whisper-server binary path, or `undefined` when none is available (so Transcription
 * reports not-ready rather than hanging). Resolution order:
 *   1. The env override, if set and non-blank - lets dev (and a packaged debug session)
 *      point at a locally-built binary, matching how tickets 10-14 ran it in dev.
 *   2. The bundled resource, when packaged - the normal installed-app path.
 *   3. The repo's locally-built `build/whisper-server`, in a dev launch, when it exists -
 *      so a dev build "just works" without setting `LUNE_WHISPER_SERVER_PATH`.
 *   4. Otherwise nothing - a dev launch that never built the binary.
 */
export function resolveWhisperServerBinaryPath(input: WhisperServerBinaryPathInput): string | undefined {
  const override = input.envOverride?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }
  if (input.isPackaged) {
    return path.join(input.resourcesPath, WHISPER_SERVER_RESOURCE_NAME);
  }
  if (
    input.devFallbackBinaryPath !== undefined &&
    input.fileExists !== undefined &&
    input.fileExists(input.devFallbackBinaryPath)
  ) {
    return input.devFallbackBinaryPath;
  }
  return undefined;
}
