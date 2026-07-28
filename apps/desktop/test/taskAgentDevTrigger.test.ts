import { afterEach, describe, expect, it } from "vitest";
import type {
  StartTaskAgentInput,
  TaskAgentHandle,
  TaskAgentListener,
  TaskAgentRuntime,
  TaskAgentSnapshot,
} from "@lune/core";

import { runTaskAgentDevTrigger } from "../src/main/taskAgent/taskAgentService";

// The env-gated dev trigger is thin glue over the Core runtime; these tests lock the two
// behaviours that matter - it does nothing on a normal launch, and it reports a terminal
// outcome - against a fake runtime.

const ENV = "LUNE_TASK_AGENT_DEV";

afterEach(() => {
  delete process.env[ENV];
});

/** A runtime whose one Session settles to the given terminal snapshot. */
function fakeRuntime(terminal: TaskAgentSnapshot): TaskAgentRuntime & { started: StartTaskAgentInput[] } {
  const started: StartTaskAgentInput[] = [];
  return {
    started,
    start(input: StartTaskAgentInput): TaskAgentHandle {
      started.push(input);
      const snapshot: TaskAgentSnapshot = {
        sessionId: terminal.sessionId,
        goal: input.goal,
        status: "running",
        step: 0,
      };
      return { sessionId: terminal.sessionId, snapshot, completion: Promise.resolve(terminal) };
    },
    cancel: () => true,
    get: () => undefined,
    list: () => [],
    subscribe: (_listener: TaskAgentListener) => () => {},
  };
}

describe("runTaskAgentDevTrigger", () => {
  it("is a no-op when the env var is absent (a normal launch)", async () => {
    const runtime = fakeRuntime({ sessionId: "s1", goal: "", status: "succeeded", step: 1, result: "ok" });
    const started = await runTaskAgentDevTrigger(runtime);
    expect(started).toBe(false);
    expect(runtime.started).toEqual([]);
  });

  it("starts a Session from the env goal and logs its terminal outcome", async () => {
    process.env[ENV] = "open example.com";
    const runtime = fakeRuntime({
      sessionId: "s1",
      goal: "open example.com",
      status: "succeeded",
      step: 2,
      result: "opened the site",
    });
    const logs: string[] = [];
    const started = await runTaskAgentDevTrigger(runtime, { log: (message) => logs.push(message) });
    expect(started).toBe(true);
    expect(runtime.started).toEqual([{ goal: "open example.com" }]);
    expect(logs.some((line) => line.includes("succeeded") && line.includes("opened the site"))).toBe(true);
  });

  it("degrades cleanly when the runtime cannot start (not-ready Vendor)", async () => {
    process.env[ENV] = "do a thing";
    const runtime = fakeRuntime({ sessionId: "s1", goal: "", status: "failed", step: 0, error: "x" });
    runtime.start = () => {
      throw new Error("Anthropic credentials are not configured");
    };
    const logs: string[] = [];
    const started = await runTaskAgentDevTrigger(runtime, { log: (message) => logs.push(message) });
    expect(started).toBe(true);
    expect(logs.some((line) => line.includes("could not start") && line.includes("credentials"))).toBe(true);
  });
});
