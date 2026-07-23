/**
 * Lazy, per-Provider child-Runtime supervision (ADR-0006), ported from v1 and scoped
 * to Lune's one child Runtime: whisper.cpp for Transcription. Some local Capabilities
 * delegate to a separate on-device process, and something must own that process so it
 * starts only when it is needed and never lingers or hangs the app.
 *
 * The supervisor reconciles a *desired* set of child Runtimes (whisper when local
 * Transcription is active) against what is running: it starts the ones that should
 * run, stops the ones that shouldn't, and health-checks each so the Core can report
 * "not ready" instead of hanging on a dead Runtime. Kokoro is deliberately not here -
 * it runs in-process (ADR-0010), so it has no child process to supervise; and Lune
 * dropped v1's LM Studio local Reasoning entirely, so whisper is the only child.
 *
 * All process I/O goes through the injected `ChildRuntimeGateway`, the one boundary
 * the tests stub, so reconcile/health logic is exercised without spawning anything
 * real. The Core owns no process, no port, and no `child_process` import; the Electron
 * main process fills the gateway with the real whisper-server spawn/health edge.
 */

/**
 * The child-process Runtimes the supervisor can own. In Lune this is only whisper
 * (in-process Kokoro is excluded, and v1's LM Studio local Reasoning was dropped).
 * Kept as a named type so the reconcile/health machinery reads the same as v1's.
 */
export type ChildRuntimeId = "whisper";

/**
 * A child Runtime's lifecycle state, surfaced to readiness:
 *   stopped  - not running (not currently desired).
 *   starting - start requested, health not yet confirmed.
 *   ready    - running and health-checks pass; safe to route to.
 *   failed   - start or health-check failed; the Capability reports "not ready".
 */
export type ChildRuntimeState = "stopped" | "starting" | "ready" | "failed";

/**
 * The process boundary: how to actually start, stop, and health-check a child
 * Runtime. Injected so the supervisor's reconcile/health logic is testable with a
 * fake, and so the real Node implementation (`nodeWhisperRuntime.ts` in the Electron
 * main process) stays a thin, untested edge.
 */
export interface ChildRuntimeGateway {
  /** Spawns the Runtime's process. Rejects if it cannot be launched. */
  start(runtimeId: ChildRuntimeId): Promise<void>;
  /** Terminates the Runtime's process. Safe to call when already stopped. */
  stop(runtimeId: ChildRuntimeId): Promise<void>;
  /** Whether the Runtime is up and answering health checks. */
  isHealthy(runtimeId: ChildRuntimeId): Promise<boolean>;
}

export class ChildRuntimeSupervisor {
  private readonly gateway: ChildRuntimeGateway;
  private readonly stateByRuntime = new Map<ChildRuntimeId, ChildRuntimeState>();

  constructor(gateway: ChildRuntimeGateway) {
    this.gateway = gateway;
  }

  /** The last known state of a Runtime; "stopped" until it is first reconciled. */
  state(runtimeId: ChildRuntimeId): ChildRuntimeState {
    return this.stateByRuntime.get(runtimeId) ?? "stopped";
  }

  /** Whether a Runtime is running and healthy, so a Capability may route to it. */
  isReady(runtimeId: ChildRuntimeId): boolean {
    return this.state(runtimeId) === "ready";
  }

  /**
   * Reconciles running Runtimes against the desired set: starts (and health-checks)
   * each desired Runtime that isn't already ready, and stops each running Runtime
   * that is no longer desired. Lazy - a Runtime absent from `desiredRuntimeIds` is
   * never started. Idempotent - reconciling to the same set re-verifies health
   * without needless restarts.
   *
   * Desired Runtimes are started *concurrently*, not one after another, and stops
   * run concurrently too: each `ensureRuntimeReady`/`stopRuntime` isolates its own
   * failure, so one slow or hanging Runtime can never delay an unrelated one. (Lune
   * supervises only whisper today, but the machinery is preserved from v1 verbatim.)
   */
  async reconcile(desiredRuntimeIds: ReadonlySet<ChildRuntimeId>): Promise<void> {
    // Stop anything running that is no longer desired (e.g. Transcription switched
    // off), freeing its memory. Stops run concurrently for the same reason starts
    // do: one Runtime's slow teardown shouldn't hold up the others.
    const runtimesToStop = [...this.stateByRuntime]
      .filter(([runtimeId, state]) => state !== "stopped" && !desiredRuntimeIds.has(runtimeId))
      .map(([runtimeId]) => runtimeId);
    await Promise.all(runtimesToStop.map((runtimeId) => this.stopRuntime(runtimeId)));

    // Start (or re-verify) each desired Runtime concurrently so a slow one can't
    // starve the others.
    await Promise.all([...desiredRuntimeIds].map((runtimeId) => this.ensureRuntimeReady(runtimeId)));
  }

  /** Re-checks a running Runtime's health and updates its state; useful before routing. */
  async refreshHealth(runtimeId: ChildRuntimeId): Promise<ChildRuntimeState> {
    if (this.state(runtimeId) === "stopped") {
      return "stopped";
    }
    const healthy = await this.gateway.isHealthy(runtimeId).catch(() => false);
    this.stateByRuntime.set(runtimeId, healthy ? "ready" : "failed");
    return this.state(runtimeId);
  }

  /** Stops every running Runtime (called on app shutdown so nothing is orphaned). */
  async stopAll(): Promise<void> {
    for (const [runtimeId, state] of this.stateByRuntime) {
      if (state !== "stopped") {
        await this.stopRuntime(runtimeId);
      }
    }
  }

  private async ensureRuntimeReady(runtimeId: ChildRuntimeId): Promise<void> {
    // Already ready: just re-verify health so a Runtime that died is caught.
    if (this.state(runtimeId) === "ready") {
      await this.refreshHealth(runtimeId);
      return;
    }

    this.stateByRuntime.set(runtimeId, "starting");
    try {
      await this.gateway.start(runtimeId);
      const healthy = await this.gateway.isHealthy(runtimeId);
      this.stateByRuntime.set(runtimeId, healthy ? "ready" : "failed");
    } catch (error) {
      console.error(`[runtime:${runtimeId}] failed to start:`, error);
      this.stateByRuntime.set(runtimeId, "failed");
    }
  }

  private async stopRuntime(runtimeId: ChildRuntimeId): Promise<void> {
    try {
      await this.gateway.stop(runtimeId);
    } catch (error) {
      console.error(`[runtime:${runtimeId}] failed to stop:`, error);
    }
    this.stateByRuntime.set(runtimeId, "stopped");
  }
}
