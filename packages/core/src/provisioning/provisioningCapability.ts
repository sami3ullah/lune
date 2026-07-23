/**
 * The Core's Provisioning Capability - the public entry point for the background
 * model-download subsystem, at full v1 strength minus LM Studio: a pinned manifest
 * (whisper large-v3-turbo + the Kokoro model + 54 voices, ~2 GB), resumable
 * checksum-verified downloads into one Lune-managed models directory, a preflight
 * that fails cleanly (offline / low disk) without starting downloads, live progress,
 * cancel, idempotent re-runs, and per-Runtime readiness derived from verified
 * weights.
 *
 * This is the successor of v1's HTTP-driven `ProvisioningController` +
 * `httpHandlers`, with HTTP removed: the Capability exposes plain typed methods the
 * Electron main process calls directly (and a future HTTP adapter could wrap). The
 * Core owns no transport, no filesystem, and no network - the main process injects
 * the Node-backed gateways (fetch / fs / statfs / dns); a test injects the in-memory
 * fakes.
 */
import { ProvisioningController, type ProvisioningStatus } from "./controller.js";
import type { ProvisioningGateways } from "./gateways.js";
import type { ProvisionableRuntime, ProvisionableRuntimeId } from "./manifest.js";
import { ProvisioningOrchestrator } from "./orchestrator.js";

/** The injected boundaries and configuration the Provisioning Capability is built from. */
export interface ProvisioningCapabilityDependencies {
  /** The only ways Provisioning touches network/fs/disk (production impls injected). */
  gateways: ProvisioningGateways;
  /** The one Lune-managed models directory every download lands under. */
  modelsDirectoryPath: string;
  /** Overrideable for tests; defaults to the pinned manifest. */
  manifest?: readonly ProvisionableRuntime[];
}

/**
 * The Core's Provisioning Capability: start/cancel a run, poll live status, refresh
 * and query per-Runtime readiness.
 */
export interface ProvisioningCapability {
  /**
   * Starts provisioning the selected Runtimes in the background and returns the
   * initial status. A no-op returning the current status if a run is already in
   * flight (so a double-trigger can't launch two runs).
   */
  start(selectedRuntimeIds: readonly ProvisionableRuntimeId[]): ProvisioningStatus;
  /** Requests cancellation of the in-flight run; partial downloads are kept for resume. */
  cancel(): void;
  /** A snapshot of the current run state (phase, progress bytes, per-Runtime results). */
  status(): ProvisioningStatus;
  /** Resolves when the current run (if any) has finished. */
  awaitCurrentRun(): Promise<void>;
  /** Re-checks every Runtime's on-disk weights and updates cached readiness. */
  refreshReadiness(): Promise<void>;
  /** Whether a Runtime's weights are currently verified (per-Capability readiness). */
  isRuntimeReady(runtimeId: ProvisionableRuntimeId): boolean;
}

/**
 * Builds the Provisioning Capability by composing the orchestrator (the idempotent,
 * checksum-verified download engine) and the controller (the background-run
 * lifecycle + cached readiness) over the injected gateways.
 */
export function createProvisioningCapability(
  dependencies: ProvisioningCapabilityDependencies,
): ProvisioningCapability {
  const orchestrator = new ProvisioningOrchestrator({
    gateways: dependencies.gateways,
    modelsDirectoryPath: dependencies.modelsDirectoryPath,
    manifest: dependencies.manifest,
  });
  const controller = new ProvisioningController(orchestrator, dependencies.manifest);

  return {
    start: (selectedRuntimeIds) => controller.start(selectedRuntimeIds),
    cancel: () => controller.cancel(),
    status: () => controller.status(),
    awaitCurrentRun: () => controller.awaitCurrentRun(),
    refreshReadiness: () => controller.refreshReadiness(),
    isRuntimeReady: (runtimeId) => controller.isRuntimeReady(runtimeId),
  };
}
