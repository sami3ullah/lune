import { describe, expect, it } from "vitest";
import {
  createScreenAgentGuardrails,
  DEFAULT_SCREEN_AGENT_GUARDRAILS,
  type ScreenAgentGuardrailConfig,
} from "../src/main/agent/screenAgentGuardrails";

// The Screen Agent's pure session guardrails (M2-03): step cap, wall-clock timeout, and
// the no-progress screen-fingerprint detector. Each limit is asserted in isolation so it
// is provably able to terminate a runaway session on its own (acceptance #3).

const CONFIG: ScreenAgentGuardrailConfig = {
  maxSteps: 3,
  maxWallClockMs: 1000,
  maxRepeatedScreens: 3,
};

describe("screen agent guardrails - step cap", () => {
  it("allows steps below the cap and stops at it", () => {
    const guardrails = createScreenAgentGuardrails(CONFIG);
    expect(guardrails.checkBudget({ stepCount: 0, elapsedMs: 0 })).toBeNull();
    expect(guardrails.checkBudget({ stepCount: 2, elapsedMs: 0 })).toBeNull();
    // The cap is a ceiling on executed Actions: at stepCount === maxSteps, no more run.
    expect(guardrails.checkBudget({ stepCount: 3, elapsedMs: 0 })).toBe("step-cap");
    expect(guardrails.checkBudget({ stepCount: 99, elapsedMs: 0 })).toBe("step-cap");
  });
});

describe("screen agent guardrails - wall-clock timeout", () => {
  it("allows time below the limit and stops at it", () => {
    const guardrails = createScreenAgentGuardrails(CONFIG);
    expect(guardrails.checkBudget({ stepCount: 0, elapsedMs: 999 })).toBeNull();
    expect(guardrails.checkBudget({ stepCount: 0, elapsedMs: 1000 })).toBe("timeout");
    expect(guardrails.checkBudget({ stepCount: 0, elapsedMs: 5000 })).toBe("timeout");
  });

  it("reports the step cap first when both budgets are exceeded (stable tie-break)", () => {
    const guardrails = createScreenAgentGuardrails(CONFIG);
    expect(guardrails.checkBudget({ stepCount: 3, elapsedMs: 5000 })).toBe("step-cap");
  });
});

describe("screen agent guardrails - no-progress detector", () => {
  it("trips only after the same scene repeats the configured number of times in a row", () => {
    const guardrails = createScreenAgentGuardrails(CONFIG);
    expect(guardrails.observeScene("a")).toBeNull(); // 1st
    expect(guardrails.observeScene("a")).toBeNull(); // 2nd
    expect(guardrails.observeScene("a")).toBe("no-progress"); // 3rd in a row -> stuck
  });

  it("resets the run length when the scene changes", () => {
    const guardrails = createScreenAgentGuardrails(CONFIG);
    expect(guardrails.observeScene("a")).toBeNull();
    expect(guardrails.observeScene("a")).toBeNull();
    // Progress: a different scene resets the counter, so the run continues.
    expect(guardrails.observeScene("b")).toBeNull();
    expect(guardrails.observeScene("b")).toBeNull();
    expect(guardrails.observeScene("b")).toBe("no-progress");
  });

  it("a changing screen never trips the detector, however long the run", () => {
    const guardrails = createScreenAgentGuardrails(CONFIG);
    for (let step = 0; step < 50; step += 1) {
      expect(guardrails.observeScene(`scene-${step}`)).toBeNull();
    }
  });

  it("can be disabled with maxRepeatedScreens: 0", () => {
    const guardrails = createScreenAgentGuardrails({ ...CONFIG, maxRepeatedScreens: 0 });
    for (let step = 0; step < 50; step += 1) {
      expect(guardrails.observeScene("same")).toBeNull();
    }
  });
});

describe("screen agent guardrails - defaults", () => {
  it("ships sane, bounded defaults", () => {
    expect(DEFAULT_SCREEN_AGENT_GUARDRAILS.maxSteps).toBeGreaterThan(0);
    expect(DEFAULT_SCREEN_AGENT_GUARDRAILS.maxWallClockMs).toBeGreaterThan(0);
    expect(DEFAULT_SCREEN_AGENT_GUARDRAILS.maxRepeatedScreens).toBeGreaterThan(0);
  });
});
