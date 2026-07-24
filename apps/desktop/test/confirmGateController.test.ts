import { describe, expect, it } from "vitest";

import type { AgentAction } from "@lune/core";
import {
  createConfirmGateController,
  type ConfirmGateAnswerSignal,
  type ConfirmGateEdges,
} from "../src/main/agent/confirmGateController";
import { DECLINE_ACKNOWLEDGMENT, REPROMPT_LINE } from "../src/main/agent/confirmGateExplanation";
import type { ConfirmGateRequest } from "../src/main/agent/screenAgentLoop";

/**
 * Unit tests for the Confirm Gate controller (M2-04): the coordinator that turns chip,
 * hotkey, and voice answers into one approve/decline, driving the pure reconciliation and
 * the plain-language explanation behind the loop's `confirm` seam. Every edge (speak, the
 * chip, answer capture) is a fake, in the style of `VoiceLoopController`'s tests, so the
 * acceptance-critical behaviour - all three modalities answer, ambiguous voice re-prompts,
 * a decline is acknowledged aloud, and a barge-in ends the wait cleanly - is pinned down
 * without any real speaker, window, or hotkey.
 */

const CLICK: AgentAction = { kind: "click", x: 10, y: 20, consequence: "consequential" };

/** A fake gate environment: records what was spoken/shown and lets a test push answers. */
function makeEdges() {
  const spoken: string[] = [];
  let chipShown = 0;
  let chipHidden = 0;
  let captureDisposed = 0;
  let deliver: ((signal: ConfirmGateAnswerSignal) => void) | null = null;

  const edges: ConfirmGateEdges = {
    speak: (text) => {
      spoken.push(text);
    },
    showChip: () => {
      chipShown += 1;
      return () => {
        chipHidden += 1;
      };
    },
    armAnswerCapture: (deliverSignal) => {
      deliver = deliverSignal;
      return () => {
        captureDisposed += 1;
        deliver = null;
      };
    },
  };

  return {
    edges,
    spoken,
    counts: () => ({ chipShown, chipHidden, captureDisposed }),
    /** Pushes one answer into the armed gate (throws if the gate isn't listening). */
    answer: (signal: ConfirmGateAnswerSignal) => {
      if (deliver === null) {
        throw new Error("no gate is currently capturing answers");
      }
      deliver(signal);
    },
    isCapturing: () => deliver !== null,
  };
}

function request(overrides: Partial<ConfirmGateRequest> = {}): ConfirmGateRequest {
  return { kind: "irreversible", action: CLICK, goal: "send the message", stepIndex: 1, ...overrides };
}

describe("ConfirmGateController - the gate opens by explaining and showing the chip", () => {
  it("speaks the explanation and shows the chip while it waits", async () => {
    const env = makeEdges();
    const gate = createConfirmGateController(env.edges);
    void gate(request());

    // Let the confirm() microtasks settle so the gate has opened.
    await Promise.resolve();

    expect(env.counts().chipShown).toBe(1);
    expect(env.spoken[0]).toContain("about to"); // the irreversible-guard phrasing
    expect(env.isCapturing()).toBe(true);
  });
});

describe("ConfirmGateController - every modality answers", () => {
  it("approves on a chip Approve, hiding the chip and tearing down capture", async () => {
    const env = makeEdges();
    const gate = createConfirmGateController(env.edges);
    const pending = gate(request());
    await Promise.resolve();

    env.answer({ source: "chip", intent: "approve" });

    await expect(pending).resolves.toBe(true);
    expect(env.counts().chipHidden).toBe(1);
    expect(env.counts().captureDisposed).toBe(1);
    expect(env.spoken).not.toContain(DECLINE_ACKNOWLEDGMENT);
  });

  it("declines on a chip Cancel and acknowledges the decline aloud", async () => {
    const env = makeEdges();
    const gate = createConfirmGateController(env.edges);
    const pending = gate(request());
    await Promise.resolve();

    env.answer({ source: "chip", intent: "cancel" });

    await expect(pending).resolves.toBe(false);
    expect(env.spoken).toContain(DECLINE_ACKNOWLEDGMENT);
  });

  it("approves on an approve hotkey and declines on a cancel hotkey", async () => {
    const approveEnv = makeEdges();
    const approveGate = createConfirmGateController(approveEnv.edges);
    const approved = approveGate(request());
    await Promise.resolve();
    approveEnv.answer({ source: "hotkey", intent: "approve" });
    await expect(approved).resolves.toBe(true);

    const cancelEnv = makeEdges();
    const cancelGate = createConfirmGateController(cancelEnv.edges);
    const declined = cancelGate(request());
    await Promise.resolve();
    cancelEnv.answer({ source: "hotkey", intent: "cancel" });
    await expect(declined).resolves.toBe(false);
  });

  it("approves on a clear spoken yes and declines (with ack) on a clear spoken no", async () => {
    const yesEnv = makeEdges();
    const yesGate = createConfirmGateController(yesEnv.edges);
    const approved = yesGate(request());
    await Promise.resolve();
    yesEnv.answer({ source: "voice", transcript: "yes go ahead" });
    await expect(approved).resolves.toBe(true);

    const noEnv = makeEdges();
    const noGate = createConfirmGateController(noEnv.edges);
    const declined = noGate(request());
    await Promise.resolve();
    noEnv.answer({ source: "voice", transcript: "no, stop" });
    await expect(declined).resolves.toBe(false);
    expect(noEnv.spoken).toContain(DECLINE_ACKNOWLEDGMENT);
  });
});

describe("ConfirmGateController - ambiguous voice re-prompts and never approves", () => {
  it("re-prompts on a mumbled reply, then approves once a clear yes arrives", async () => {
    const env = makeEdges();
    const gate = createConfirmGateController(env.edges);
    const pending = gate(request());
    await Promise.resolve();

    // A mumble: the gate must not proceed - it re-asks and keeps listening.
    env.answer({ source: "voice", transcript: "uhh hmm" });
    expect(env.spoken).toContain(REPROMPT_LINE);
    expect(env.isCapturing()).toBe(true);

    // A clear yes then approves.
    env.answer({ source: "voice", transcript: "yeah" });
    await expect(pending).resolves.toBe(true);
  });

  it("still lets a cancel win after an ambiguous reply", async () => {
    const env = makeEdges();
    const gate = createConfirmGateController(env.edges);
    const pending = gate(request());
    await Promise.resolve();

    env.answer({ source: "voice", transcript: "what?" });
    env.answer({ source: "chip", intent: "cancel" });

    await expect(pending).resolves.toBe(false);
  });
});

describe("ConfirmGateController - barge-in ends the wait without a spoken decline", () => {
  it("resolves not-approved and tears down when the run is aborted mid-wait", async () => {
    const env = makeEdges();
    const controller = new AbortController();
    const gate = createConfirmGateController(env.edges);
    const pending = gate(request({ signal: controller.signal }));
    await Promise.resolve();

    controller.abort();

    await expect(pending).resolves.toBe(false);
    expect(env.counts().chipHidden).toBe(1);
    expect(env.counts().captureDisposed).toBe(1);
    // A barge-in is a cancellation of the whole session, not a gate decline: no ack over the
    // fresh recording that the barge-in has already started.
    expect(env.spoken).not.toContain(DECLINE_ACKNOWLEDGMENT);
  });

  it("resolves immediately when the signal is already aborted before the gate opens", async () => {
    const env = makeEdges();
    const controller = new AbortController();
    controller.abort();
    const gate = createConfirmGateController(env.edges);

    await expect(gate(request({ signal: controller.signal }))).resolves.toBe(false);
    expect(env.isCapturing()).toBe(false);
  });
});

describe("ConfirmGateController - a settled gate ignores later answers", () => {
  it("does not resolve twice or re-hide the chip when a stray answer arrives after settling", async () => {
    const env = makeEdges();
    const gate = createConfirmGateController(env.edges);
    const pending = gate(request());
    await Promise.resolve();

    env.answer({ source: "chip", intent: "approve" });
    await expect(pending).resolves.toBe(true);
    // The armed capture is disposed on settle, so no further answers can arrive.
    expect(env.isCapturing()).toBe(false);
    expect(env.counts().chipHidden).toBe(1);
  });
});
