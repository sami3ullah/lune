import { downloadArtifact, type DownloadProgress } from "./download.js";
import type { ProvisioningGateways } from "./gateways.js";
import {
  findRuntime,
  PROVISIONING_MANIFEST,
  resolveRuntimes,
  type PinnedArtifact,
  type ProvisionableRuntime,
  type ProvisionableRuntimeId,
} from "./manifest.js";
import { runPreflight, type PreflightResult } from "./preflight.js";
import { isArtifactVerified } from "./verify.js";

/**
 * The Provisioning orchestrator (ADR-0009): runs the preflight, then provisions
 * each selected Runtime's pinned artifacts into the one managed models directory.
 *
 * It is **idempotent per-Runtime**: an artifact that already exists and verifies is
 * skipped - so re-running after a partial failure retries only what actually failed,
 * never the gigabytes already on disk. A failure in one Runtime is isolated: the
 * others still provision, and the failed one can be retried by re-running. A Runtime
 * is "ready" only once every one of its artifacts verifies, so a half-provisioned
 * model is never reported ready.
 */

/** How a single artifact ended up satisfied (or not). */
export type ArtifactOutcome = "downloaded" | "already-present" | "failed";

export interface ArtifactResult {
  artifactId: string;
  outcome: ArtifactOutcome;
  /** Absolute path to the usable file when satisfied. */
  resolvedPath?: string;
  /** Present when `outcome` is "failed". */
  error?: string;
}

export interface RuntimeResult {
  runtimeId: ProvisionableRuntimeId;
  /** True only when every artifact verified (downloaded or already present). */
  ready: boolean;
  artifacts: ArtifactResult[];
}

export interface ProvisioningResult {
  preflight: PreflightResult;
  /** Per selected Runtime; empty when preflight failed (nothing was attempted). */
  runtimes: RuntimeResult[];
  /** True when preflight passed and every selected Runtime is ready. */
  ok: boolean;
}

/** Aggregate progress across the run, forwarded per artifact chunk. */
export interface ProvisioningProgress extends DownloadProgress {
  runtimeId: ProvisionableRuntimeId;
}

export type ProvisioningProgressCallback = (progress: ProvisioningProgress) => void;

/**
 * The per-run hooks that travel together through the whole run: progress reporting
 * and cancellation polling. Bundled so they aren't threaded as a separate pair of
 * positional parameters through every internal method.
 */
export interface ProvisioningRunContext {
  onProgress?: ProvisioningProgressCallback;
  isCancelled?: () => boolean;
}

export interface ProvisioningOrchestratorOptions {
  gateways: ProvisioningGateways;
  /** The one Lune-managed models directory all downloads land under. */
  modelsDirectoryPath: string;
  /** Overrideable for tests; defaults to the pinned manifest. */
  manifest?: readonly ProvisionableRuntime[];
}

export class ProvisioningOrchestrator {
  private readonly gateways: ProvisioningGateways;
  private readonly modelsDirectoryPath: string;
  private readonly manifest: readonly ProvisionableRuntime[];

  constructor(options: ProvisioningOrchestratorOptions) {
    this.gateways = options.gateways;
    this.modelsDirectoryPath = options.modelsDirectoryPath;
    this.manifest = options.manifest ?? PROVISIONING_MANIFEST;
  }

  /**
   * Provisions the selected Runtimes. Runs the preflight first; if it fails
   * (offline, insufficient disk) nothing is downloaded and the failure is returned
   * for the UI. Otherwise each Runtime is provisioned independently so one failure
   * doesn't block the rest.
   */
  async provision(
    selectedRuntimeIds: readonly ProvisionableRuntimeId[],
    runContext: ProvisioningRunContext = {},
  ): Promise<ProvisioningResult> {
    const selectedRuntimes = resolveRuntimes(selectedRuntimeIds, this.manifest);

    const preflight = await runPreflight({
      runtimes: selectedRuntimes,
      modelsDirectoryPath: this.modelsDirectoryPath,
      diskSpace: this.gateways.diskSpace,
      network: this.gateways.network,
    });

    if (!preflight.ok) {
      return { preflight, runtimes: [], ok: false };
    }

    const runtimeResults: RuntimeResult[] = [];
    for (const runtime of selectedRuntimes) {
      // Stop starting new Runtimes once cancelled; in-flight downloads also stop
      // themselves between chunks (leaving partials for resume).
      if (runContext.isCancelled?.()) {
        break;
      }
      runtimeResults.push(await this.provisionRuntime(runtime, runContext));
    }

    return {
      preflight,
      runtimes: runtimeResults,
      ok: runtimeResults.length === selectedRuntimes.length && runtimeResults.every((result) => result.ready),
    };
  }

  /**
   * Whether a Runtime is fully provisioned right now: every one of its artifacts
   * verifies at its managed path. This is the signal a Capability consults to report
   * ready / not-ready (ADR-0009).
   */
  async isRuntimeProvisioned(runtimeId: ProvisionableRuntimeId): Promise<boolean> {
    const runtime = findRuntime(runtimeId, this.manifest);
    if (runtime === undefined) {
      return false;
    }
    for (const artifact of runtime.artifacts) {
      if (!(await isArtifactVerified(this.gateways.fileSystem, this.managedPathFor(artifact), artifact))) {
        return false;
      }
    }
    return true;
  }

  private async provisionRuntime(
    runtime: ProvisionableRuntime,
    runContext: ProvisioningRunContext,
  ): Promise<RuntimeResult> {
    const artifactResults: ArtifactResult[] = [];
    for (const artifact of runtime.artifacts) {
      artifactResults.push(await this.provisionArtifact(runtime, artifact, runContext));
    }

    return {
      runtimeId: runtime.id,
      ready: artifactResults.every((result) => result.outcome !== "failed"),
      artifacts: artifactResults,
    };
  }

  private async provisionArtifact(
    runtime: ProvisionableRuntime,
    artifact: PinnedArtifact,
    runContext: ProvisioningRunContext,
  ): Promise<ArtifactResult> {
    const managedPath = this.managedPathFor(artifact);

    try {
      // Already downloaded and valid? Skip (idempotent re-run) - but still report
      // its bytes so a re-run's progress bar reaches 100% rather than stalling.
      if (await isArtifactVerified(this.gateways.fileSystem, managedPath, artifact)) {
        this.reportArtifactComplete(runtime, artifact, runContext);
        return { artifactId: artifact.id, outcome: "already-present", resolvedPath: managedPath };
      }

      await downloadArtifact({
        artifact,
        destinationPath: managedPath,
        download: this.gateways.download,
        fileSystem: this.gateways.fileSystem,
        isCancelled: runContext.isCancelled,
        onProgress: runContext.onProgress
          ? (progress) => runContext.onProgress!({ ...progress, runtimeId: runtime.id })
          : undefined,
      });
      return { artifactId: artifact.id, outcome: "downloaded", resolvedPath: managedPath };
    } catch (error) {
      return { artifactId: artifact.id, outcome: "failed", error: String(error) };
    }
  }

  /**
   * Emits a full-progress event for an artifact that was satisfied without a
   * download (already present), so the aggregate progress still accounts for its
   * bytes and reaches 100%.
   */
  private reportArtifactComplete(
    runtime: ProvisionableRuntime,
    artifact: PinnedArtifact,
    runContext: ProvisioningRunContext,
  ): void {
    runContext.onProgress?.({
      runtimeId: runtime.id,
      artifactId: artifact.id,
      downloadedBytes: artifact.sizeBytes,
      totalBytes: artifact.sizeBytes,
    });
  }

  private managedPathFor(artifact: PinnedArtifact): string {
    return `${this.modelsDirectoryPath}/${artifact.relativePath}`;
  }
}
