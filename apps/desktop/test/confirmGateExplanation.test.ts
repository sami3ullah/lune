import { describe, expect, it } from "vitest";

import type { AgentAction } from "@lune/core";
import {
  DECLINE_ACKNOWLEDGMENT,
  REPROMPT_LINE,
  buildGateSpokenLine,
  describeGateAction,
} from "../src/main/agent/confirmGateExplanation";
import type { ConfirmGateRequest } from "../src/main/agent/screenAgentLoop";

/**
 * Unit tests for the Confirm Gate's plain-language spoken line (M2-04, revised): the gate
 * fires only before a consequential Action and must say *what* Lune is about to do in words
 * a user understands, then ask for a yes or no. Pure over the request, so it is pinned down
 * here without any speaker.
 */

function request(action: AgentAction, overrides: Partial<ConfirmGateRequest> = {}): ConfirmGateRequest {
  return { action, stepIndex: 1, ...overrides };
}

describe("describeGateAction - a plain phrase per Action kind", () => {
  it("describes each canonical Action in words, never raw coordinates", () => {
    expect(describeGateAction({ kind: "click", x: 12, y: 34, consequence: "benign" })).toBe("click on the screen");
    expect(describeGateAction({ kind: "key", combo: "cmd+s", consequence: "benign" })).toBe('press "cmd+s"');
    expect(describeGateAction({ kind: "scroll", x: 1, y: 2, direction: "down", amount: 3, consequence: "benign" })).toBe(
      "scroll down",
    );
    expect(describeGateAction({ kind: "copy", text: "hi", consequence: "benign" })).toBe("copy text to the clipboard");
    expect(describeGateAction({ kind: "observe", consequence: "benign" })).toBe("take a look at your screen");
  });

  it("quotes the text it will type, shortening a long string", () => {
    expect(describeGateAction({ kind: "type", text: "hello", consequence: "benign" })).toBe('type "hello"');
    const long = "a".repeat(200);
    const described = describeGateAction({ kind: "type", text: long, consequence: "benign" });
    expect(described.length).toBeLessThan(long.length);
    expect(described).toContain("…");
  });

  it("notes when a type Action also submits (presses Enter)", () => {
    expect(describeGateAction({ kind: "type", text: "hi", pressEnter: true, consequence: "consequential" })).toBe(
      'type "hi" and press Enter',
    );
  });
});

describe("buildGateSpokenLine - the consequential guard flags that it is hard to undo", () => {
  const line = buildGateSpokenLine(
    request({ kind: "type", text: "Sending now", pressEnter: true, consequence: "consequential" }),
  );

  it("describes the consequential Action in plain words and warns it may be hard to undo", () => {
    expect(line).toContain("Sending now");
    expect(line.toLowerCase()).toContain("undo");
  });

  it("asks the user to answer by voice (yes / no)", () => {
    expect(line.toLowerCase()).toContain("yes");
    expect(line.toLowerCase()).toContain("no");
  });

  it("never leaks raw coordinates or vendor jargon", () => {
    const clickLine = buildGateSpokenLine(request({ kind: "click", x: 812, y: 344, consequence: "consequential" }));
    expect(clickLine).toContain("click on the screen");
    expect(clickLine).not.toContain("812");
  });
});

describe("constant lines", () => {
  it("has a re-prompt nudge that asks for yes or no again", () => {
    expect(REPROMPT_LINE.toLowerCase()).toContain("yes");
    expect(REPROMPT_LINE.toLowerCase()).toContain("no");
  });

  it("has a spoken decline acknowledgment", () => {
    expect(DECLINE_ACKNOWLEDGMENT.length).toBeGreaterThan(0);
  });
});
