import {
  createProvisioningCapability,
  PROVISIONING_MANIFEST,
  type ProvisioningCapability,
  type ProvisionableRuntimeId,
} from "@lune/core";
import { createNodeProvisioningGateways } from "./nodeGateways";

/**
 * Wires the Core's Provisioning Capability to the real Node gateways for the Electron
 * main process (ticket 08). The Core owns all the download/verify/preflight logic;
 * this only injects the platform edge (fetch/fs/statfs/dns) and the one Lune-managed
 * models directory every artifact lands under.
 *
 * The env-gated dev trigger (`LUNE_PROVISION_ON_START`) is how ticket 08's first
 * acceptance is exercised before the onboarding UI exists (ticket 14): it downloads
 * the real pinned weights with visible progress in the dev console and lands verified
 * files in the managed directory. It is off unless the env var is set, so a normal
 * launch never starts a ~2 GB download.
 */

/** Every Runtime the pinned manifest declares (whisper + kokoro). */
const ALL_RUNTIME_IDS: ProvisionableRuntimeId[] = PROVISIONING_MANIFEST.map((runtime) => runtime.id);

export interface DesktopProvisioning {
  capability: ProvisioningCapability;
  /** The one managed models directory, for logging / diagnostics. */
  modelsDirectoryPath: string;
}

/** Builds the Provisioning Capability over the real gateways, rooted at the given directory. */
export function createDesktopProvisioning(modelsDirectoryPath: string): DesktopProvisioning {
  const capability = createProvisioningCapability({
    gateways: createNodeProvisioningGateways(),
    modelsDirectoryPath,
  });
  return { capability, modelsDirectoryPath };
}

/** How often the dev trigger samples and logs live download progress. */
const DEV_PROGRESS_LOG_INTERVAL_MS = 1000;

/**
 * The dev trigger (env-gated on `LUNE_PROVISION_ON_START`). Refreshes readiness, then
 * - if any Runtime's weights aren't already verified - starts a real download of every
 * pinned Runtime, logging live progress until the run settles. A no-op (beyond a
 * readiness refresh) when the env var is absent or everything is already provisioned,
 * so it is safe to call unconditionally at boot.
 *
 * @returns whether a download run was actually started.
 */
export async function runProvisioningDevTrigger(
  provisioning: DesktopProvisioning,
  log: (message: string) => void = (message) => console.log(`[lune] ${message}`),
): Promise<boolean> {
  const { capability, modelsDirectoryPath } = provisioning;

  // Always reconcile cached readiness with what's on disk, so a returning user whose
  // weights are already present reports ready immediately (no re-download).
  await capability.refreshReadiness();

  if (process.env.LUNE_PROVISION_ON_START === undefined || process.env.LUNE_PROVISION_ON_START.length === 0) {
    return false;
  }

  const alreadyReady = ALL_RUNTIME_IDS.every((runtimeId) => capability.isRuntimeReady(runtimeId));
  if (alreadyReady) {
    log(`provisioning dev trigger: all model weights already verified in ${modelsDirectoryPath}`);
    return false;
  }

  log(`provisioning dev trigger: downloading model weights into ${modelsDirectoryPath}`);
  capability.start(ALL_RUNTIME_IDS);

  // Sample progress on an interval so the ~2 GB download shows a live bar in the dev
  // console. The interval is cleared once the run settles.
  const progressTimer = setInterval(() => {
    const status = capability.status();
    if (status.totalBytes > 0) {
      const percent = Math.floor((status.downloadedBytes / status.totalBytes) * 100);
      log(`provisioning ${status.phase}: ${percent}% (${status.downloadedBytes}/${status.totalBytes} bytes)`);
    }
  }, DEV_PROGRESS_LOG_INTERVAL_MS);

  try {
    await capability.awaitCurrentRun();
  } finally {
    clearInterval(progressTimer);
  }

  const settled = capability.status();
  if (settled.phase === "succeeded") {
    log("provisioning succeeded: all model weights verified in the managed directory");
  } else if (settled.preflightFailure !== undefined) {
    log(`provisioning ${settled.phase}: ${settled.preflightFailure.reason} - ${settled.preflightFailure.detail}`);
  } else {
    log(`provisioning ${settled.phase}`);
  }
  return true;
}
