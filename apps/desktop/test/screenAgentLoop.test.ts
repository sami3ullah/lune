import { describe, expect, it, vi } from "vitest";
import type { AgentAction, ScreenAgentStepInput } from "@lune/core";
import { ScreenAgentNotReadyError } from "@lune/core";
import {
  runScreenAgentLoop,
  type ConfirmGateRequest,
  type SceneCapture,
  type ScreenAgentLoopDependencies,
} from "../src/main/agent/screenAgentLoop";
import {
  createScreenAgentGuardrails,
  type ScreenAgentGuardrailConfig,
} from "../src/main/agent/screenAgentGuardrails";
import {
  AccessibilityNotGrantedError,
  SyntheticInputUnavailableError,
} from "../src/main/agent/syntheticInputExecutor";
import type { AgentDisplayGeometry } from "../src/main/agent/agentCoordinateRemap";

// The Screen Agent loop (M2-03): decide -> confirm -> execute -> capture, bounded by the
// guardrails, with the advisory->act boundary, barge-in cancellation, and clean error
// stops. Every OS/Core edge is a fake, so the full control flow is asserted without a real
// screen, Vendor, or synthetic input (acceptance #3).

const GEOMETRY: AgentDisplayGeometry = {
  bounds: { x: 0, y: 0, width: 1000, height: 800 },
  capturedWidth: 1000,
  capturedHeight: 800,
};

/** A scene whose fingerprint the test can control (each distinct `tag` = a changed screen). */
function scene(tag: string): SceneCapture {
  return {
    screenshot: { base64Data: tag, mediaType: "image/jpeg" },
    geometry: GEOMETRY,
    display: { width: 1000, height: 800 },
  };
}

/** Common canonical Actions. */
const CLICK_BENIGN: AgentAction = { kind: "click", x: 10, y: 20, consequence: "benign" };
const CLICK_CONSEQUENTIAL: AgentAction = { kind: "click", x: 10, y: 20, consequence: "consequential" };
const DONE: AgentAction = { kind: "done", finalText: "All set." };

const GUARDRAIL_CONFIG: ScreenAgentGuardrailConfig = {
  maxSteps: 20,
  maxWallClockMs: 60_000,
  maxRepeatedScreens: 3,
};

/** Records every execute call so tests can assert the OS was (or wasn't) touched. */
interface Harness {
  deps: ScreenAgentLoopDependencies;
  executed: AgentAction[];
  spoken: string[];
  confirmRequests: ConfirmGateRequest[];
  decideInputs: ScreenAgentStepInput[];
}

/**
 * Builds a loop harness. `actions` are returned by successive `decideStep` calls (the last
 * one repeats if the loop asks for more). `scenes`, likewise, are the successive captures
 * (the last repeats), so a test controls both the model's decisions and the screen.
 */
function makeHarness(options: {
  actions: AgentAction[];
  scenes?: SceneCapture[];
  confirm?: (request: ConfirmGateRequest) => Promise<boolean>;
  guardrails?: ScreenAgentGuardrailConfig;
  now?: () => number;
  signal?: AbortSignal;
  onExecute?: (action: AgentAction) => void;
}): Harness {
  const executed: AgentAction[] = [];
  const spoken: string[] = [];
  const confirmRequests: ConfirmGateRequest[] = [];
  const decideInputs: ScreenAgentStepInput[] = [];

  const scenes = options.scenes ?? [scene("a"), scene("b"), scene("c"), scene("d"), scene("e")];
  let captureIndex = 0;
  let decideIndex = 0;

  // Whatever confirm the test supplies (or a default approve) is wrapped once so every
  // request is recorded regardless of the decision it returns.
  const innerConfirm = options.confirm ?? (async () => true);

  const deps: ScreenAgentLoopDependencies = {
    goal: "open settings and turn on dark mode",
    sessionId: "session-1",
    captureScene: async () => {
      const next = scenes[Math.min(captureIndex, scenes.length - 1)]!;
      captureIndex += 1;
      return next;
    },
    decideStep: async (input) => {
      decideInputs.push(input);
      const action = options.actions[Math.min(decideIndex, options.actions.length - 1)]!;
      decideIndex += 1;
      return action;
    },
    execute: async (action) => {
      options.onExecute?.(action);
      executed.push(action);
    },
    confirm: async (request) => {
      confirmRequests.push(request);
      return innerConfirm(request);
    },
    speak: (finalText) => {
      spoken.push(finalText);
    },
    guardrails: createScreenAgentGuardrails(options.guardrails ?? GUARDRAIL_CONFIG),
    hashScreenshot: (screenshot) => screenshot.base64Data,
    now: options.now ?? (() => 0),
    signal: options.signal,
  };

  return { deps, executed, spoken, confirmRequests, decideInputs };
}

describe("screen agent loop - advisory -> act boundary", () => {
  it("a first-step done speaks and never touches the OS (answer-only turn)", async () => {
    const harness = makeHarness({ actions: [DONE] });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("completed");
    expect(result.advisory).toBe(true);
    expect(result.stepsExecuted).toBe(0);
    expect(result.finalText).toBe("All set.");
    expect(harness.executed).toHaveLength(0); // acceptance #2: no OS touch
    expect(harness.spoken).toEqual(["All set."]);
    expect(harness.confirmRequests).toHaveLength(0); // never even confirmed
  });

  it("only the first step carries the goal + display; later steps carry neither", async () => {
    const harness = makeHarness({ actions: [CLICK_BENIGN, DONE] });
    await runScreenAgentLoop(harness.deps);

    expect(harness.decideInputs[0]?.goal).toBe("open settings and turn on dark mode");
    expect(harness.decideInputs[0]?.display).toEqual({ width: 1000, height: 800 });
    expect(harness.decideInputs[1]?.goal).toBeUndefined();
    expect(harness.decideInputs[1]?.display).toBeUndefined();
  });
});

describe("screen agent loop - a full multi-step run", () => {
  it("drives decide -> confirm-to-start -> execute -> capture until done", async () => {
    const harness = makeHarness({
      actions: [CLICK_BENIGN, { kind: "type", text: "hi", consequence: "benign" }, DONE],
      scenes: [scene("a"), scene("b"), scene("c")],
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("completed");
    expect(result.advisory).toBe(false);
    expect(result.stepsExecuted).toBe(2);
    expect(harness.executed).toEqual([
      CLICK_BENIGN,
      { kind: "type", text: "hi", consequence: "benign" },
    ]);
    // Only the first (confirm-to-start) gate fires; the benign type mid-session doesn't.
    expect(harness.confirmRequests).toHaveLength(1);
    expect(harness.confirmRequests[0]?.kind).toBe("confirm-to-start");
  });

  it("the trivial 1-step type-at-cursor case works", async () => {
    const typeAtCursor: AgentAction = { kind: "type", text: "hello world", consequence: "benign" };
    const harness = makeHarness({ actions: [typeAtCursor, DONE], scenes: [scene("a"), scene("b")] });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("completed");
    expect(result.stepsExecuted).toBe(1);
    expect(harness.executed).toEqual([typeAtCursor]);
  });
});

describe("screen agent loop - confirm gates", () => {
  it("gates a consequential mid-session action (irreversible guard)", async () => {
    const harness = makeHarness({
      actions: [CLICK_BENIGN, CLICK_CONSEQUENTIAL, DONE],
      scenes: [scene("a"), scene("b"), scene("c")],
    });
    await runScreenAgentLoop(harness.deps);

    expect(harness.confirmRequests.map((request) => request.kind)).toEqual([
      "confirm-to-start",
      "irreversible",
    ]);
  });

  it("a declined confirm-to-start ends the run without any OS touch", async () => {
    const harness = makeHarness({ actions: [CLICK_BENIGN], confirm: async () => false });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("declined");
    expect(result.stepsExecuted).toBe(0);
    expect(harness.executed).toHaveLength(0);
  });

  it("a declined mid-session gate ends the run, keeping the already-run steps", async () => {
    const harness = makeHarness({
      actions: [CLICK_BENIGN, CLICK_CONSEQUENTIAL],
      scenes: [scene("a"), scene("b"), scene("c")],
      confirm: async (request) => request.kind === "confirm-to-start",
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("declined");
    expect(result.stepsExecuted).toBe(1);
    expect(harness.executed).toEqual([CLICK_BENIGN]);
  });
});

describe("screen agent loop - guardrails terminate a runaway session", () => {
  it("the step cap stops an endless benign-click model", async () => {
    // The model never returns done and the screen keeps changing, so only the step cap
    // can stop it.
    const changingScenes = Array.from({ length: 50 }, (_unused, index) => scene(`s-${index}`));
    const harness = makeHarness({
      actions: [CLICK_BENIGN],
      scenes: changingScenes,
      guardrails: { maxSteps: 5, maxWallClockMs: 1_000_000, maxRepeatedScreens: 0 },
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("step-cap");
    expect(result.stepsExecuted).toBe(5);
    expect(harness.executed).toHaveLength(5);
  });

  it("the wall-clock timeout stops a slow-but-progressing model", async () => {
    const changingScenes = Array.from({ length: 50 }, (_unused, index) => scene(`s-${index}`));
    // Each `now()` read advances 100ms; the loop reads it once per iteration for the budget
    // check, so it trips the 350ms limit on the 4th iteration.
    let clock = 0;
    const harness = makeHarness({
      actions: [CLICK_BENIGN],
      scenes: changingScenes,
      guardrails: { maxSteps: 1000, maxWallClockMs: 350, maxRepeatedScreens: 0 },
      now: () => {
        const value = clock;
        clock += 100;
        return value;
      },
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("timeout");
  });

  it("the no-progress detector stops a model stuck on an unchanging screen", async () => {
    // The model keeps clicking but the screen never changes (a dead spot); neither the step
    // cap nor the timeout is near, so only the no-progress detector can stop it.
    const harness = makeHarness({
      actions: [CLICK_BENIGN],
      scenes: [scene("frozen")],
      guardrails: { maxSteps: 1000, maxWallClockMs: 1_000_000, maxRepeatedScreens: 3 },
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("no-progress");
    // Two Actions execute (scenes 1 and 2 tolerated); the 3rd identical scene trips it
    // before another decide.
    expect(harness.executed).toHaveLength(2);
  });
});

describe("screen agent loop - barge-in cancellation", () => {
  it("stops before the first capture when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeHarness({ actions: [CLICK_BENIGN], signal: controller.signal });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("cancelled");
    expect(harness.executed).toHaveLength(0);
  });

  it("stops mid-session on abort, ceasing to execute", async () => {
    const controller = new AbortController();
    // Abort as soon as the first Action executes, so the next iteration sees the signal.
    const harness = makeHarness({
      actions: [CLICK_BENIGN],
      scenes: Array.from({ length: 10 }, (_unused, index) => scene(`s-${index}`)),
      signal: controller.signal,
      onExecute: () => controller.abort(),
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("cancelled");
    expect(harness.executed).toHaveLength(1); // the one in-flight Action, then it ceases
  });

  it("does not execute an approved action if a barge-in lands during the confirm", async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      actions: [CLICK_BENIGN],
      // Barge-in fires while the user is answering the confirm gate.
      confirm: async () => {
        controller.abort();
        return true;
      },
      signal: controller.signal,
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("cancelled");
    expect(harness.executed).toHaveLength(0); // approved, but cancelled before the OS touch
  });

  it("classifies a barge-in that ends the gate as cancelled, not a decline", async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      actions: [CLICK_BENIGN],
      // A real gate aborts its own wait on barge-in and resolves not-approved; the loop
      // must read the aborted signal as a cancellation rather than a user decline.
      confirm: async (request) => {
        controller.abort();
        return request.signal?.aborted === true ? false : true;
      },
      signal: controller.signal,
    });
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("cancelled");
    expect(harness.executed).toHaveLength(0);
  });

  it("passes the run's barge-in signal into each confirm request", async () => {
    const controller = new AbortController();
    const harness = makeHarness({ actions: [CLICK_BENIGN], signal: controller.signal });
    await runScreenAgentLoop(harness.deps);

    expect(harness.confirmRequests[0]?.signal).toBe(controller.signal);
  });

  it("honours a barge-in before a benign, non-gated Action executes", async () => {
    const controller = new AbortController();
    // Step 0 is gated + approved + executed; step 1 is a benign mid-session Action (no gate).
    const harness = makeHarness({
      actions: [CLICK_BENIGN, CLICK_BENIGN],
      confirm: async () => true,
      signal: controller.signal,
    });
    // A push-to-talk barge-in lands while the model is deciding the second (benign) step -
    // between the decide and the execute, where no confirm gate would catch it.
    let decideCalls = 0;
    const realDecide = harness.deps.decideStep;
    harness.deps.decideStep = async (input) => {
      decideCalls += 1;
      if (decideCalls === 2) {
        controller.abort();
      }
      return realDecide(input);
    };
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("cancelled");
    // Only step 0 ran; the benign step 1 was abandoned before touching the OS.
    expect(harness.executed).toHaveLength(1);
  });
});

describe("screen agent loop - clean stop on error", () => {
  it("classifies a Core not-ready as not-ready", async () => {
    const harness = makeHarness({ actions: [CLICK_BENIGN] });
    harness.deps.decideStep = async () => {
      throw new ScreenAgentNotReadyError("no key");
    };
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("not-ready");
    expect(result.error).toBeInstanceOf(ScreenAgentNotReadyError);
  });

  it("classifies a missing Accessibility grant so the Shell can route to the pane", async () => {
    const harness = makeHarness({ actions: [CLICK_BENIGN] });
    harness.deps.execute = async () => {
      throw new AccessibilityNotGrantedError();
    };
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("accessibility");
  });

  it("classifies a missing native backend as unavailable", async () => {
    const harness = makeHarness({ actions: [CLICK_BENIGN] });
    harness.deps.execute = async () => {
      throw new SyntheticInputUnavailableError();
    };
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("unavailable");
  });

  it("classifies any other failure as a generic error and never throws", async () => {
    const harness = makeHarness({ actions: [CLICK_BENIGN] });
    harness.deps.captureScene = async () => {
      throw new Error("capture blew up");
    };
    const result = await runScreenAgentLoop(harness.deps);

    expect(result.reason).toBe("error");
    expect((result.error as Error).message).toBe("capture blew up");
  });
});
