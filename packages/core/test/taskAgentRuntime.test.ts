import { describe, expect, it } from "vitest";

import {
  createTaskAgentRuntime,
  TaskAgentNotReadyError,
  TaskAgentStartInputError,
  type TaskAgentRuntimeDependencies,
} from "../src/taskAgent/taskAgentRuntime.js";
import { createToolRegistry } from "../src/taskAgent/toolRegistry.js";
import type {
  TaskAgentModel,
  TaskAgentModelMessage,
  TaskAgentModelRequest,
  TaskAgentModelTurn,
  TaskAgentToolCall,
} from "../src/taskAgent/taskAgentModel.js";
import type { TaskAgentTool } from "../src/taskAgent/toolTypes.js";
import type { TaskAgentEvent } from "../src/taskAgent/taskAgentTypes.js";
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "../src/reasoning/routingConfig.js";

// The Task Agent runtime is tested at the Core seam - exactly how the Electron main
// process drives it - by injecting a stub tool-calling model (scripted per goal) and
// stubbed tools, then observing the snapshots and the multiplexed event stream. No
// network, no Vendor, no OS.

/** A tool that records every call and returns a canned output. */
function recordingTool(name: string, output: string): TaskAgentTool & {
  calls: Array<{ input: Record<string, unknown>; sessionId: string }>;
} {
  const calls: Array<{ input: Record<string, unknown>; sessionId: string }> = [];
  return {
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: {} },
    calls,
    async execute(input, context) {
      calls.push({ input, sessionId: context.sessionId });
      return { output };
    },
  };
}

/** Shorthand for one requested tool call. */
function toolCall(id: string, name: string, input: Record<string, unknown> = {}): TaskAgentToolCall {
  return { id, name, input };
}

/** A turn that calls tools. */
function callsTools(...toolCalls: TaskAgentToolCall[]): TaskAgentModelTurn {
  return { text: "", toolCalls };
}

/** A terminal turn (no tool calls) carrying the final spoken result. */
function finishes(text: string): TaskAgentModelTurn {
  return { text, toolCalls: [] };
}

/** The first user message's text - the goal that keys a Session's script. */
function goalOf(messages: readonly TaskAgentModelMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  return first !== undefined && first.role === "user" ? first.text : "";
}

/**
 * A stub model that replays a scripted sequence of turns per goal, indexed by how many
 * assistant turns the conversation already holds - so it advances one step at a time and
 * each concurrent Session (keyed by its distinct goal) is answered independently.
 */
function scriptedModel(scripts: Record<string, TaskAgentModelTurn[]>): TaskAgentModel & {
  requests: TaskAgentModelRequest[];
} {
  const requests: TaskAgentModelRequest[] = [];
  return {
    requests,
    async generate(request) {
      requests.push(request);
      const goal = goalOf(request.messages);
      const priorAssistantTurns = request.messages.filter((message) => message.role === "assistant").length;
      const script = scripts[goal] ?? [];
      return script[priorAssistantTurns] ?? finishes("done");
    },
  };
}

/** Base deps routed to Anthropic with a present key; each test overrides `models`/`tools`. */
function deps(
  overrides: Partial<TaskAgentRuntimeDependencies> & Pick<TaskAgentRuntimeDependencies, "models" | "tools">,
): TaskAgentRuntimeDependencies {
  const routingConfig: RoutingConfig = {
    ...DEFAULT_ROUTING_CONFIG,
    reasoning: { vendor: "anthropic", modelSlot: "claude-sonnet-4-6" },
  };
  return {
    getRoutingConfig: () => routingConfig,
    getApiKey: () => "sk-test",
    upstreamFetch: async () => new Response("{}", { status: 200 }),
    ...overrides,
  };
}

/** Collects every event the runtime publishes, in order. */
function recordEvents(runtime: { subscribe(listener: (event: TaskAgentEvent) => void): () => void }): TaskAgentEvent[] {
  const events: TaskAgentEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return events;
}

describe("createTaskAgentRuntime - a multi-step tool plan", () => {
  it("runs the model->tools->model loop to a terminal result, streaming events in order", async () => {
    const search = recordingTool("search", "found 3 results");
    const writeFile = recordingTool("write_file", "wrote note.txt");
    const model = scriptedModel({
      "plan my day": [
        callsTools(toolCall("c1", "search", { query: "weather" })),
        callsTools(toolCall("c2", "write_file", { path: "note.txt" })),
        finishes("done, saved you a little note"),
      ],
    });
    const runtime = createTaskAgentRuntime(
      deps({ models: { anthropic: model }, tools: createToolRegistry([search, writeFile]) }),
    );
    const events = recordEvents(runtime);

    const handle = runtime.start({ goal: "plan my day", sessionId: "s1" });
    expect(handle.snapshot).toEqual({ sessionId: "s1", goal: "plan my day", status: "running", step: 0 });

    const finalSnapshot = await handle.completion;
    expect(finalSnapshot).toEqual({
      sessionId: "s1",
      goal: "plan my day",
      status: "succeeded",
      step: 3,
      result: "done, saved you a little note",
    });

    // Each tool ran once, addressed with the Session's id and the model's arguments.
    expect(search.calls).toEqual([{ input: { query: "weather" }, sessionId: "s1" }]);
    expect(writeFile.calls).toEqual([{ input: { path: "note.txt" }, sessionId: "s1" }]);

    // The event stream is the full, observable trace of the plan.
    expect(events).toEqual([
      { type: "started", sessionId: "s1", goal: "plan my day" },
      { type: "step-started", sessionId: "s1", step: 1 },
      { type: "tool-call", sessionId: "s1", step: 1, toolCallId: "c1", toolName: "search", input: { query: "weather" } },
      { type: "tool-result", sessionId: "s1", step: 1, toolCallId: "c1", toolName: "search", output: "found 3 results", isError: false },
      { type: "step-started", sessionId: "s1", step: 2 },
      { type: "tool-call", sessionId: "s1", step: 2, toolCallId: "c2", toolName: "write_file", input: { path: "note.txt" } },
      { type: "tool-result", sessionId: "s1", step: 2, toolCallId: "c2", toolName: "write_file", output: "wrote note.txt", isError: false },
      { type: "step-started", sessionId: "s1", step: 3 },
      { type: "message", sessionId: "s1", step: 3, text: "done, saved you a little note" },
      { type: "succeeded", sessionId: "s1", result: "done, saved you a little note" },
    ]);
  });

  it("feeds each tool result back into the next model turn's conversation", async () => {
    const search = recordingTool("search", "sunny, 24C");
    const model = scriptedModel({
      "what's the weather": [callsTools(toolCall("c1", "search")), finishes("it's sunny")],
    });
    const runtime = createTaskAgentRuntime(
      deps({ models: { anthropic: model }, tools: createToolRegistry([search]) }),
    );

    await runtime.start({ goal: "what's the weather", sessionId: "s1" }).completion;

    // The second model turn saw the assistant tool-call turn and the tool result appended.
    const secondTurnMessages = model.requests[1]!.messages;
    expect(secondTurnMessages).toEqual([
      { role: "user", text: "what's the weather" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "search", input: {} }] },
      { role: "tool", results: [{ toolCallId: "c1", toolName: "search", output: "sunny, 24C", isError: false }] },
    ]);
    // The runtime hands the model the registry's tool schemas each turn.
    expect(model.requests[0]!.tools).toEqual([
      { name: "search", description: "stub search", parameters: { type: "object", properties: {} } },
    ]);
  });

  it("surfaces an unknown tool as a recoverable error result the model can react to", async () => {
    const model = scriptedModel({
      goal: [callsTools(toolCall("c1", "does_not_exist")), finishes("recovered")],
    });
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([]) }));
    const events = recordEvents(runtime);

    const snapshot = await runtime.start({ goal: "goal", sessionId: "s1" }).completion;

    expect(snapshot.status).toBe("succeeded");
    expect(events).toContainEqual({
      type: "tool-result",
      sessionId: "s1",
      step: 1,
      toolCallId: "c1",
      toolName: "does_not_exist",
      output: "Unknown tool: 'does_not_exist'",
      isError: true,
    });
    // The error result was fed back so the model could recover to a finish.
    const secondTurn = model.requests[1]!.messages.at(-1);
    expect(secondTurn).toEqual({
      role: "tool",
      results: [{ toolCallId: "c1", toolName: "does_not_exist", output: "Unknown tool: 'does_not_exist'", isError: true }],
    });
  });

  it("turns a throwing tool into a recoverable error result rather than crashing the Session", async () => {
    const boom: TaskAgentTool = {
      name: "boom",
      description: "throws",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("disk full");
      },
    };
    const model = scriptedModel({ g: [callsTools(toolCall("c1", "boom")), finishes("handled it")] });
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([boom]) }));
    const events = recordEvents(runtime);

    const snapshot = await runtime.start({ goal: "g", sessionId: "s1" }).completion;

    expect(snapshot.status).toBe("succeeded");
    expect(events).toContainEqual({
      type: "tool-result",
      sessionId: "s1",
      step: 1,
      toolCallId: "c1",
      toolName: "boom",
      output: "disk full",
      isError: true,
    });
  });
});

describe("createTaskAgentRuntime - concurrent Sessions", () => {
  it("runs three Sessions at once without interference, each with its own result", async () => {
    const alpha = recordingTool("alpha", "A");
    const beta = recordingTool("beta", "B");
    const gamma = recordingTool("gamma", "C");
    const model = scriptedModel({
      "goal a": [callsTools(toolCall("a1", "alpha")), finishes("result A")],
      "goal b": [callsTools(toolCall("b1", "beta")), finishes("result B")],
      "goal c": [callsTools(toolCall("c1", "gamma")), finishes("result C")],
    });
    const runtime = createTaskAgentRuntime(
      deps({ models: { anthropic: model }, tools: createToolRegistry([alpha, beta, gamma]) }),
    );

    const handles = [
      runtime.start({ goal: "goal a", sessionId: "a" }),
      runtime.start({ goal: "goal b", sessionId: "b" }),
      runtime.start({ goal: "goal c", sessionId: "c" }),
    ];
    const snapshots = await Promise.all(handles.map((handle) => handle.completion));

    expect(snapshots.map((snapshot) => ({ id: snapshot.sessionId, status: snapshot.status, result: snapshot.result }))).toEqual([
      { id: "a", status: "succeeded", result: "result A" },
      { id: "b", status: "succeeded", result: "result B" },
      { id: "c", status: "succeeded", result: "result C" },
    ]);
    // Each Session's tool was called exactly once, addressed with its own id - no crosstalk.
    expect(alpha.calls).toEqual([{ input: {}, sessionId: "a" }]);
    expect(beta.calls).toEqual([{ input: {}, sessionId: "b" }]);
    expect(gamma.calls).toEqual([{ input: {}, sessionId: "c" }]);
    expect(runtime.list().map((snapshot) => snapshot.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("cancels one Session while the others keep running to success", async () => {
    // A model that never resolves for the "stuck" goal (honouring the abort signal) but
    // answers the others immediately - so cancelling the stuck one can't stall the rest.
    const tool = recordingTool("noop", "ok");
    const model: TaskAgentModel = {
      async generate(request) {
        if (goalOf(request.messages) === "stuck") {
          return new Promise<TaskAgentModelTurn>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return finishes("all good");
      },
    };
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([tool]) }));
    const events = recordEvents(runtime);

    const stuck = runtime.start({ goal: "stuck", sessionId: "stuck" });
    const healthy = runtime.start({ goal: "fine", sessionId: "healthy" });

    // The healthy Session finishes regardless of the stuck one.
    expect(await healthy.completion).toMatchObject({ sessionId: "healthy", status: "succeeded", result: "all good" });

    expect(runtime.cancel("stuck")).toBe(true);
    expect(await stuck.completion).toMatchObject({ sessionId: "stuck", status: "cancelled" });

    // Cancelling emitted a cancelled event for the stuck Session only.
    expect(events).toContainEqual({ type: "cancelled", sessionId: "stuck" });
    expect(events.some((event) => event.type === "cancelled" && event.sessionId === "healthy")).toBe(false);
    expect(runtime.get("healthy")).toMatchObject({ status: "succeeded" });
    expect(runtime.get("stuck")).toMatchObject({ status: "cancelled" });
  });

  it("cancels a Session blocked in a long-running tool", async () => {
    const hangingTool: TaskAgentTool = {
      name: "hang",
      description: "never returns until aborted",
      parameters: { type: "object", properties: {} },
      async execute(_input, context) {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    };
    const model = scriptedModel({ g: [callsTools(toolCall("c1", "hang"))] });
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([hangingTool]) }));

    const handle = runtime.start({ goal: "g", sessionId: "s1" });
    // Let the loop reach the tool call before cancelling.
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.cancel("s1")).toBe(true);

    expect(await handle.completion).toMatchObject({ sessionId: "s1", status: "cancelled" });
  });

  it("reports cancel of an unknown or already-terminal Session as false", async () => {
    const model = scriptedModel({ g: [finishes("done")] });
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([]) }));

    expect(runtime.cancel("missing")).toBe(false);
    const snapshot = await runtime.start({ goal: "g", sessionId: "s1" }).completion;
    expect(snapshot.status).toBe("succeeded");
    // Already terminal - a late cancel is a no-op.
    expect(runtime.cancel("s1")).toBe(false);
  });
});

describe("createTaskAgentRuntime - failures and gating", () => {
  it("fails the Session with the Vendor's error when the model call throws", async () => {
    const model: TaskAgentModel = {
      async generate() {
        throw new Error("HTTP 429 - rate limited");
      },
    };
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([]) }));
    const events = recordEvents(runtime);

    const snapshot = await runtime.start({ goal: "g", sessionId: "s1" }).completion;

    expect(snapshot).toMatchObject({ status: "failed", error: "HTTP 429 - rate limited" });
    expect(events.at(-1)).toEqual({ type: "failed", sessionId: "s1", message: "HTTP 429 - rate limited" });
  });

  it("fails the Session when the model loops past the step limit instead of running forever", async () => {
    const loopTool = recordingTool("loop", "again");
    // Always calls the tool, never finishes.
    const model: TaskAgentModel = {
      async generate() {
        return callsTools(toolCall("c", "loop"));
      },
    };
    const runtime = createTaskAgentRuntime(
      deps({ models: { anthropic: model }, tools: createToolRegistry([loopTool]), maxSteps: 3 }),
    );

    const snapshot = await runtime.start({ goal: "g", sessionId: "s1" }).completion;

    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toContain("3-step limit");
    expect(snapshot.step).toBe(3);
  });

  it("throws TaskAgentNotReadyError before starting when the routed Vendor has no key", () => {
    const model = scriptedModel({});
    const runtime = createTaskAgentRuntime(
      deps({ models: { anthropic: model }, tools: createToolRegistry([]), getApiKey: () => undefined }),
    );

    expect(() => runtime.start({ goal: "g" })).toThrow(TaskAgentNotReadyError);
    expect(runtime.list()).toEqual([]);
  });

  it("throws TaskAgentNotReadyError when no adapter is wired for the routed Vendor", () => {
    // Routed to Anthropic, but only a Google adapter is wired.
    const runtime = createTaskAgentRuntime(
      deps({ models: { google: scriptedModel({}) }, tools: createToolRegistry([]) }),
    );
    expect(() => runtime.start({ goal: "g" })).toThrow(TaskAgentNotReadyError);
  });

  it("rejects a blank goal", () => {
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: scriptedModel({}) }, tools: createToolRegistry([]) }));
    expect(() => runtime.start({ goal: "   " })).toThrow(TaskAgentStartInputError);
  });

  it("rejects starting a second Session with an id already in use", () => {
    const model = scriptedModel({ g: [finishes("done")] });
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([]) }));
    runtime.start({ goal: "g", sessionId: "dup" });
    expect(() => runtime.start({ goal: "g", sessionId: "dup" })).toThrow(TaskAgentStartInputError);
  });

  it("mints unique ids when the caller supplies none", async () => {
    const model = scriptedModel({});
    const runtime = createTaskAgentRuntime(deps({ models: { anthropic: model }, tools: createToolRegistry([]) }));
    const first = runtime.start({ goal: "a" });
    const second = runtime.start({ goal: "b" });
    expect(first.sessionId).not.toBe(second.sessionId);
    await Promise.all([first.completion, second.completion]);
  });
});
