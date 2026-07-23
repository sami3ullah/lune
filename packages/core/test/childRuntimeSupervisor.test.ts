import { describe, expect, it } from "vitest";

import {
  ChildRuntimeSupervisor,
  type ChildRuntimeGateway,
  type ChildRuntimeId,
} from "../src/transcription/childRuntimeSupervisor.js";

/**
 * Tests for the child-Runtime supervisor (ADR-0006), ported from v1 and scoped to
 * Lune's one child Runtime, whisper: lazy per-config start, stop-when-no-longer-
 * desired, and health surfacing - with the process boundary stubbed so nothing real
 * is spawned. (v1 also drove an LM Studio Runtime; Lune dropped local Reasoning, so
 * whisper is the only child - "lazy" is now shown by reconciling to the empty set.)
 */

// A fake process boundary recording start/stop calls and letting a test control
// health and start failures per Runtime.
class FakeChildRuntimeGateway implements ChildRuntimeGateway {
  readonly startCalls: ChildRuntimeId[] = [];
  readonly stopCalls: ChildRuntimeId[] = [];
  private readonly unhealthy = new Set<ChildRuntimeId>();
  private readonly startFailures = new Set<ChildRuntimeId>();

  markUnhealthy(runtimeId: ChildRuntimeId): void {
    this.unhealthy.add(runtimeId);
  }

  failStart(runtimeId: ChildRuntimeId): void {
    this.startFailures.add(runtimeId);
  }

  async start(runtimeId: ChildRuntimeId): Promise<void> {
    this.startCalls.push(runtimeId);
    if (this.startFailures.has(runtimeId)) {
      throw new Error(`simulated start failure for ${runtimeId}`);
    }
  }

  async stop(runtimeId: ChildRuntimeId): Promise<void> {
    this.stopCalls.push(runtimeId);
  }

  async isHealthy(runtimeId: ChildRuntimeId): Promise<boolean> {
    return !this.unhealthy.has(runtimeId);
  }
}

const WHISPER_ONLY: ReadonlySet<ChildRuntimeId> = new Set<ChildRuntimeId>(["whisper"]);
const NONE: ReadonlySet<ChildRuntimeId> = new Set<ChildRuntimeId>();

describe("ChildRuntimeSupervisor.reconcile", () => {
  it("starts the desired Runtime and marks a healthy one ready", async () => {
    const gateway = new FakeChildRuntimeGateway();
    const supervisor = new ChildRuntimeSupervisor(gateway);

    await supervisor.reconcile(WHISPER_ONLY);

    expect(gateway.startCalls).toEqual(["whisper"]);
    expect(supervisor.isReady("whisper")).toBe(true);
  });

  it("never starts a Runtime that isn't desired (lazy startup)", async () => {
    const gateway = new FakeChildRuntimeGateway();
    const supervisor = new ChildRuntimeSupervisor(gateway);

    // Reconciling to the empty desired set must not spawn anything.
    await supervisor.reconcile(NONE);

    expect(gateway.startCalls).toEqual([]);
    expect(supervisor.state("whisper")).toBe("stopped");
  });

  it("stops a Runtime that is no longer desired (reconciliation frees it)", async () => {
    const gateway = new FakeChildRuntimeGateway();
    const supervisor = new ChildRuntimeSupervisor(gateway);

    await supervisor.reconcile(WHISPER_ONLY);
    expect(supervisor.isReady("whisper")).toBe(true);

    await supervisor.reconcile(NONE);

    expect(gateway.stopCalls).toEqual(["whisper"]);
    expect(supervisor.state("whisper")).toBe("stopped");
  });

  it("marks a Runtime failed when it starts but is unhealthy", async () => {
    const gateway = new FakeChildRuntimeGateway();
    gateway.markUnhealthy("whisper");
    const supervisor = new ChildRuntimeSupervisor(gateway);

    await supervisor.reconcile(WHISPER_ONLY);

    expect(supervisor.state("whisper")).toBe("failed");
    expect(supervisor.isReady("whisper")).toBe(false);
  });

  it("marks a Runtime failed when start throws, without crashing reconcile", async () => {
    const gateway = new FakeChildRuntimeGateway();
    gateway.failStart("whisper");
    const supervisor = new ChildRuntimeSupervisor(gateway);

    await supervisor.reconcile(WHISPER_ONLY);

    expect(supervisor.state("whisper")).toBe("failed");
  });

  it("does not restart an already-ready Runtime on repeat reconcile (idempotent)", async () => {
    const gateway = new FakeChildRuntimeGateway();
    const supervisor = new ChildRuntimeSupervisor(gateway);

    await supervisor.reconcile(WHISPER_ONLY);
    await supervisor.reconcile(WHISPER_ONLY);

    expect(gateway.startCalls).toEqual(["whisper"]); // started once, not twice
    expect(supervisor.isReady("whisper")).toBe(true);
  });
});

describe("ChildRuntimeSupervisor.refreshHealth", () => {
  it("flips a ready Runtime to failed when it stops answering health checks", async () => {
    const gateway = new FakeChildRuntimeGateway();
    const supervisor = new ChildRuntimeSupervisor(gateway);
    await supervisor.reconcile(WHISPER_ONLY);
    expect(supervisor.isReady("whisper")).toBe(true);

    gateway.markUnhealthy("whisper");
    const state = await supervisor.refreshHealth("whisper");

    expect(state).toBe("failed");
    expect(supervisor.isReady("whisper")).toBe(false);
  });

  it("reports stopped for a Runtime that was never started", async () => {
    const supervisor = new ChildRuntimeSupervisor(new FakeChildRuntimeGateway());
    expect(await supervisor.refreshHealth("whisper")).toBe("stopped");
  });
});

describe("ChildRuntimeSupervisor.stopAll", () => {
  it("stops every running Runtime", async () => {
    const gateway = new FakeChildRuntimeGateway();
    const supervisor = new ChildRuntimeSupervisor(gateway);
    await supervisor.reconcile(WHISPER_ONLY);

    await supervisor.stopAll();

    expect(gateway.stopCalls).toEqual(["whisper"]);
    expect(supervisor.state("whisper")).toBe("stopped");
  });
});
