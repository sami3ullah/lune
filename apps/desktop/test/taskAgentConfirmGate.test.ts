import { describe, expect, it } from "vitest";
import type { ToolConfirmRequest } from "@lune/core";

import type {
  ConfirmGateAnswerSignal,
  ConfirmGateEdges,
} from "../src/main/agent/confirmGateController";
import {
  buildToolGateLine,
  createToolConfirmGateController,
} from "../src/main/taskAgent/toolConfirmGateController";

// The Task Agent Confirm Gate reuses the Screen Agent's fail-safe reconciliation, so these
// tests focus on the tool-shaped glue: the spoken line, and that approve/decline/ambiguous +
// abort resolve the way the ticket requires (cancel always beats approve).

function request(overrides: Partial<ToolConfirmRequest> = {}): ToolConfirmRequest {
  return {
    toolName: "run_shell_command",
    summary: "run the command: rm -rf ~/Documents",
    consequence: { level: "consequential", reason: "runs the non-allowlisted command 'rm'" },
    ...overrides,
  };
}

/** Edges that record spoken lines and hand back a controllable answer deliverer. */
function fakeEdges(): ConfirmGateEdges & {
  spoken: string[];
  deliver: (signal: ConfirmGateAnswerSignal) => void;
  disposed: boolean;
} {
  const spoken: string[] = [];
  let deliver: (signal: ConfirmGateAnswerSignal) => void = () => {};
  const state = {
    spoken,
    get deliver() {
      return deliver;
    },
    disposed: false,
    speak: (text: string) => {
      spoken.push(text);
    },
    armAnswerCapture: (handler: (signal: ConfirmGateAnswerSignal) => void) => {
      deliver = handler;
      return () => {
        state.disposed = true;
      };
    },
  };
  return state;
}

describe("buildToolGateLine", () => {
  it("names the concrete action and asks for a plain yes or no", () => {
    const line = buildToolGateLine(request());
    expect(line).toContain("run the command: rm -rf ~/Documents");
    expect(line.toLowerCase()).toContain("yes or no");
  });
});

describe("createToolConfirmGateController", () => {
  it("speaks the line and resolves true on a clear spoken yes", async () => {
    const edges = fakeEdges();
    const gate = createToolConfirmGateController(edges);
    const pending = gate(request());
    expect(edges.spoken[0]).toContain("rm -rf ~/Documents");
    edges.deliver({ source: "voice", transcript: "yes go ahead" });
    expect(await pending).toBe(true);
    expect(edges.disposed).toBe(true);
  });

  it("resolves false and acknowledges on a clear spoken no", async () => {
    const edges = fakeEdges();
    const gate = createToolConfirmGateController(edges);
    const pending = gate(request());
    edges.deliver({ source: "voice", transcript: "no, cancel" });
    expect(await pending).toBe(false);
    expect(edges.spoken.some((line) => line.includes("leaving it"))).toBe(true);
  });

  it("re-prompts on an ambiguous reply instead of ever proceeding", async () => {
    const edges = fakeEdges();
    const gate = createToolConfirmGateController(edges);
    const pending = gate(request());
    edges.deliver({ source: "voice", transcript: "uhh maybe" });
    // Not settled: a re-prompt was spoken, then a clear yes settles it.
    expect(edges.spoken.some((line) => line.includes("didn't catch that"))).toBe(true);
    edges.deliver({ source: "voice", transcript: "yes" });
    expect(await pending).toBe(true);
  });

  it("cancel beats a concurrent approve", async () => {
    const edges = fakeEdges();
    const gate = createToolConfirmGateController(edges);
    const pending = gate(request());
    edges.deliver({ source: "voice", transcript: "yeah no don't" });
    expect(await pending).toBe(false);
  });

  it("resolves false immediately when the Session is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const edges = fakeEdges();
    const gate = createToolConfirmGateController(edges);
    expect(await gate(request({ signal: controller.signal }))).toBe(false);
  });

  it("resolves false without speaking when a Barge-in aborts mid-wait", async () => {
    const controller = new AbortController();
    const edges = fakeEdges();
    const gate = createToolConfirmGateController(edges);
    const pending = gate(request({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toBe(false);
    // Only the opening line was spoken - no decline ack over the incoming barge-in.
    expect(edges.spoken).toHaveLength(1);
  });
});
