import { describe, expect, it } from "vitest";

import type { AgentAction } from "../src/agent/agentAction";
import {
  applyConsequenceFloor,
  resolveConsequenceFloor,
  type AgentTargetSignal,
} from "../src/agent/consequenceFloor";

/**
 * Unit tests for the escalate-only Consequence Level floor (DECISIONS #15). The floor
 * is the safety net that forces irreversible-looking Actions to `consequential`
 * regardless of what the model tagged, so the two load-bearing properties are: it
 * escalates the right patterns, and it can NEVER downgrade a model-tagged
 * `consequential` Action. Carried from v1's Sidecar suite.
 */

/** A click Action the model tagged benign, at a coordinate. */
function benignClickAt(x: number, y: number): AgentAction {
  return { kind: "click", x, y, consequence: "benign" };
}

/** A target signal with one AX element covering a region, plus optional context. */
function signalWithElement(element: {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  role?: string;
}): AgentTargetSignal {
  return { elements: [element] };
}

describe("resolveConsequenceFloor - which patterns escalate", () => {
  it("escalates a click whose target label matches a consequential keyword (Send)", () => {
    const signal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label: "Send" });
    expect(resolveConsequenceFloor(benignClickAt(10, 10), signal)).toBe("consequential");
  });

  it("escalates for other consequential keywords (delete, pay, submit, buy)", () => {
    for (const label of ["Delete", "Pay now", "Submit order", "Buy", "Confirm purchase"]) {
      const signal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label });
      expect(resolveConsequenceFloor(benignClickAt(10, 10), signal)).toBe("consequential");
    }
  });

  it("escalates a click on a link-role element (navigating to a new URL)", () => {
    const signal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label: "Open docs", role: "AXLink" });
    expect(resolveConsequenceFloor(benignClickAt(10, 10), signal)).toBe("consequential");
  });

  it("leaves a click on a benign element benign", () => {
    const signal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label: "Cancel", role: "AXButton" });
    expect(resolveConsequenceFloor(benignClickAt(10, 10), signal)).toBe("benign");
  });

  it("hit-tests the coordinate: a click outside every element is benign", () => {
    const signal = signalWithElement({ x: 0, y: 0, width: 50, height: 50, label: "Send" });
    expect(resolveConsequenceFloor(benignClickAt(999, 999), signal)).toBe("benign");
  });

  it("picks the smallest (innermost) element when frames nest", () => {
    const signal: AgentTargetSignal = {
      elements: [
        { x: 0, y: 0, width: 500, height: 500, label: "Send", role: "AXGroup" },
        { x: 10, y: 10, width: 40, height: 20, label: "Cancel", role: "AXButton" },
      ],
    };
    // The click lands inside both; the innermost (Cancel) wins, so it stays benign.
    expect(resolveConsequenceFloor(benignClickAt(20, 15), signal)).toBe("benign");
  });

  it("escalates Return in a send-like focused context", () => {
    const signal: AgentTargetSignal = { focusedLabel: "Search", focusedRole: "AXTextField" };
    const returnKey: AgentAction = { kind: "key", combo: "return", consequence: "benign" };
    expect(resolveConsequenceFloor(returnKey, signal)).toBe("consequential");
  });

  it("escalates cmd+return in a send-like context too", () => {
    const signal: AgentTargetSignal = { focusedLabel: "Message", focusedRole: "AXTextArea" };
    const submitKey: AgentAction = { kind: "key", combo: "cmd+return", consequence: "benign" };
    expect(resolveConsequenceFloor(submitKey, signal)).toBe("consequential");
  });

  it("leaves Return in a non-send context benign", () => {
    const signal: AgentTargetSignal = { focusedLabel: "Notes", focusedRole: "AXTextArea" };
    const returnKey: AgentAction = { kind: "key", combo: "return", consequence: "benign" };
    expect(resolveConsequenceFloor(returnKey, signal)).toBe("benign");
  });

  it("leaves a non-submit key benign even in a send-like context", () => {
    const signal: AgentTargetSignal = { focusedLabel: "Send", focusedRole: "AXTextField" };
    const key: AgentAction = { kind: "key", combo: "cmd+a", consequence: "benign" };
    expect(resolveConsequenceFloor(key, signal)).toBe("benign");
  });

  it("treats a plain type, scroll, copy, and observe as benign", () => {
    const signal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label: "Send" });
    const actions: AgentAction[] = [
      { kind: "type", text: "hello", consequence: "benign" },
      { kind: "scroll", x: 10, y: 10, direction: "down", amount: 3, consequence: "benign" },
      { kind: "copy", text: "hello", consequence: "benign" },
      { kind: "observe", consequence: "benign" },
    ];
    for (const action of actions) {
      expect(resolveConsequenceFloor(action, signal)).toBe("benign");
    }
  });

  it("escalates a compound type that submits (press-enter) in a send-like context", () => {
    const signal: AgentTargetSignal = { focusedLabel: "Search", focusedRole: "AXTextField" };
    const submittingType: AgentAction = { kind: "type", text: "query", pressEnter: true, consequence: "benign" };
    expect(resolveConsequenceFloor(submittingType, signal)).toBe("consequential");
  });

  it("leaves a compound type that submits in a non-send context benign", () => {
    const signal: AgentTargetSignal = { focusedLabel: "Notes", focusedRole: "AXTextArea" };
    const submittingType: AgentAction = { kind: "type", text: "a note", pressEnter: true, consequence: "benign" };
    expect(resolveConsequenceFloor(submittingType, signal)).toBe("benign");
  });

  it("leaves a compound type that does not submit benign even in a send-like context", () => {
    const signal: AgentTargetSignal = { focusedLabel: "Send message", focusedRole: "AXTextArea" };
    const nonSubmittingType: AgentAction = { kind: "type", text: "draft", pressEnter: false, consequence: "benign" };
    expect(resolveConsequenceFloor(nonSubmittingType, signal)).toBe("benign");
  });

  it("is benign when no target signal is supplied", () => {
    expect(resolveConsequenceFloor(benignClickAt(10, 10), undefined)).toBe("benign");
  });
});

describe("applyConsequenceFloor - escalate-only application", () => {
  it("escalates a benign-tagged click to consequential when the floor matches", () => {
    const signal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label: "Send" });
    const result = applyConsequenceFloor(benignClickAt(10, 10), signal);
    expect(result).toEqual({ kind: "click", x: 10, y: 10, consequence: "consequential" });
  });

  it("never downgrades a model-tagged consequential Action, even with a benign floor", () => {
    const modelTaggedConsequential: AgentAction = { kind: "click", x: 10, y: 10, consequence: "consequential" };
    const benignSignal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label: "Cancel" });
    const result = applyConsequenceFloor(modelTaggedConsequential, benignSignal);
    expect(result.kind === "click" && result.consequence).toBe("consequential");
  });

  it("leaves a benign Action benign when nothing escalates it", () => {
    const signal = signalWithElement({ x: 0, y: 0, width: 100, height: 40, label: "Cancel" });
    const result = applyConsequenceFloor(benignClickAt(10, 10), signal);
    expect(result.kind === "click" && result.consequence).toBe("benign");
  });

  it("returns the terminal done Action unchanged (it carries no consequence)", () => {
    const done: AgentAction = { kind: "done", finalText: "all set" };
    expect(applyConsequenceFloor(done, undefined)).toEqual(done);
  });
});
