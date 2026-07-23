import {
  PROVISIONING_MANIFEST,
  resolveRuntimes,
  totalDownloadBytes,
  type ProvisionableRuntime,
  type ProvisionableRuntimeId,
} from "./manifest.js";
import {
  type ProvisioningOrchestrator,
  type ProvisioningProgress,
  type RuntimeResult,
} from "./orchestrator.js";
import type { PreflightResult } from "./preflight.js";

/**
 * Drives one Provisioning run in the background and exposes its live state, so the
 * Shell can start Provisioning with one call and poll a progress bar. It also caches
 * each Runtime's verified/ready state - refreshed at startup and after every run -
 * so a local Capability can report "not ready" until its weights verify (ADR-0009)
 * without a filesystem check on every readiness query.
 */

export type ProvisioningPhase = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProvisioningStatus {
  phase: ProvisioningPhase;
  /** Total bytes to download for the selected Runtimes (for the progress bar). */
  totalBytes: number;
  /** Bytes downloaded so far across all artifacts in this run. */
  downloadedBytes: number;
  /** Per-Runtime outcome from the last run, empty while idle or before completion. */
  runtimes: RuntimeResult[];
  /** Present when preflight failed (offline / insufficient disk). */
  preflightFailure?: PreflightResult["failure"];
}

export class ProvisioningController {
  private readonly orchestrator: ProvisioningOrchestrator;
  private readonly manifest: readonly ProvisionableRuntime[];

  private phase: ProvisioningPhase = "idle";
  private totalBytes = 0;
  private lastRuntimeResults: RuntimeResult[] = [];
  private preflightFailure: PreflightResult["failure"];
  /** Live per-artifact downloaded bytes for the current/last run. */
  private downloadedBytesByArtifact = new Map<string, number>();

  private cancelRequested = false;
  private currentRun: Promise<void> | undefined;

  /** Cached "weights verified" state per Runtime, powering readiness queries. */
  private readonly readyRuntimeIds = new Set<ProvisionableRuntimeId>();

  constructor(orchestrator: ProvisioningOrchestrator, manifest?: readonly ProvisionableRuntime[]) {
    this.orchestrator = orchestrator;
    this.manifest = manifest ?? PROVISIONING_MANIFEST;
  }

  /** Whether a Runtime's weights are currently verified (cached; call `refreshReadiness`). */
  isRuntimeReady(runtimeId: ProvisionableRuntimeId): boolean {
    return this.readyRuntimeIds.has(runtimeId);
  }

  /** Re-checks every Runtime's on-disk weights and updates the cached readiness. */
  async refreshReadiness(): Promise<void> {
    for (const runtime of this.manifest) {
      const provisioned = await this.orchestrator.isRuntimeProvisioned(runtime.id);
      if (provisioned) {
        this.readyRuntimeIds.add(runtime.id);
      } else {
        this.readyRuntimeIds.delete(runtime.id);
      }
    }
  }

  /**
   * Starts provisioning the selected Runtimes in the background. If a run is already
   * in flight this is a no-op that returns the current status, so a double-click
   * can't launch two runs.
   */
  start(selectedRuntimeIds: readonly ProvisionableRuntimeId[]): ProvisioningStatus {
    if (this.phase === "running") {
      return this.status();
    }

    const selectedRuntimes = resolveRuntimes(selectedRuntimeIds, this.manifest);

    this.phase = "running";
    this.cancelRequested = false;
    this.preflightFailure = undefined;
    this.lastRuntimeResults = [];
    this.downloadedBytesByArtifact = new Map();
    this.totalBytes = totalDownloadBytes(selectedRuntimes);

    this.currentRun = this.run(selectedRuntimes.map((runtime) => runtime.id));
    return this.status();
  }

  /** Requests cancellation of the in-flight run; partial downloads are kept for resume. */
  cancel(): void {
    if (this.phase === "running") {
      this.cancelRequested = true;
    }
  }

  /** A snapshot of the current run state, safe to serialize for a status query. */
  status(): ProvisioningStatus {
    let downloadedBytes = 0;
    for (const artifactBytes of this.downloadedBytesByArtifact.values()) {
      downloadedBytes += artifactBytes;
    }
    return {
      phase: this.phase,
      totalBytes: this.totalBytes,
      downloadedBytes,
      runtimes: this.lastRuntimeResults,
      preflightFailure: this.preflightFailure,
    };
  }

  /** Resolves when the current run (if any) has finished. Used by tests and shutdown. */
  async awaitCurrentRun(): Promise<void> {
    await this.currentRun;
  }

  private async run(selectedRuntimeIds: readonly ProvisionableRuntimeId[]): Promise<void> {
    try {
      const result = await this.orchestrator.provision(selectedRuntimeIds, {
        onProgress: (progress: ProvisioningProgress) => {
          this.downloadedBytesByArtifact.set(progress.artifactId, progress.downloadedBytes);
        },
        isCancelled: () => this.cancelRequested,
      });

      this.lastRuntimeResults = result.runtimes;
      this.preflightFailure = result.preflight.failure;

      if (this.cancelRequested) {
        this.phase = "cancelled";
      } else if (result.ok) {
        this.phase = "succeeded";
      } else {
        this.phase = "failed";
      }
    } catch (error) {
      // An unexpected throw (not a clean per-Runtime failure) still ends the run.
      console.error("[provisioning] run failed:", error);
      this.phase = this.cancelRequested ? "cancelled" : "failed";
    } finally {
      // Refresh readiness so status reflects whatever verified during the run.
      await this.refreshReadiness();
    }
  }
}
