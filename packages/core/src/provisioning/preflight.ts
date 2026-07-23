import type { DiskSpaceProbe, NetworkProbe } from "./gateways.js";
import { totalDownloadBytes, type ProvisionableRuntime } from "./manifest.js";

/**
 * The Provisioning preflight (ADR-0009): the checks that must pass before a byte is
 * fetched, so a run fails clearly and early instead of stalling or dying halfway.
 * It verifies the network is reachable and there is enough free disk for the
 * artifacts about to be downloaded.
 *
 * Preflight never downloads anything itself; it only gates. It returns a clean,
 * typed failure (never throws) for the expected boring failures - no network, not
 * enough disk - so the caller can report them as UI state (spec user story 11).
 */

/** Why a preflight failed, so the UI can tell the user what to fix. */
export type PreflightFailureReason = "network-unavailable" | "insufficient-disk";

export interface PreflightResult {
  ok: boolean;
  /** Present when `ok` is false. */
  failure?: {
    reason: PreflightFailureReason;
    /** Human-readable explanation for the UI. */
    detail: string;
    /** For insufficient-disk: bytes required vs free, so the UI can be specific. */
    requiredBytes?: number;
    availableBytes?: number;
  };
}

export interface PreflightOptions {
  /** The Runtimes about to be provisioned - determines the disk needed. */
  runtimes: readonly ProvisionableRuntime[];
  /** The managed models directory whose volume must have room. */
  modelsDirectoryPath: string;
  diskSpace: DiskSpaceProbe;
  network: NetworkProbe;
  /**
   * Safety margin (bytes) required on top of the raw download size, so the volume
   * isn't filled to the last byte. Defaults to 2 GB.
   */
  freeSpaceMarginBytes?: number;
}

const DEFAULT_FREE_SPACE_MARGIN_BYTES = 2_000_000_000;

/**
 * Runs the preflight. Returns a clean failure (never throws) for the expected
 * boring failures - no network, not enough disk - so the caller reports them as
 * UI state.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const marginBytes = options.freeSpaceMarginBytes ?? DEFAULT_FREE_SPACE_MARGIN_BYTES;

  // Network first: everything downstream needs it, and "you're offline" is the
  // clearest possible early failure.
  if (!(await options.network.isOnline())) {
    return {
      ok: false,
      failure: {
        reason: "network-unavailable",
        detail: "No network connection. Connect to the internet and try again.",
      },
    };
  }

  // Disk: refuse before starting if the volume can't hold the artifacts + margin.
  const requiredBytes = totalDownloadBytes(options.runtimes) + marginBytes;
  const availableBytes = await options.diskSpace.freeBytes(options.modelsDirectoryPath);
  if (availableBytes < requiredBytes) {
    return {
      ok: false,
      failure: {
        reason: "insufficient-disk",
        detail: "Not enough free disk space to download the models. Free up space and try again.",
        requiredBytes,
        availableBytes,
      },
    };
  }

  return { ok: true };
}
