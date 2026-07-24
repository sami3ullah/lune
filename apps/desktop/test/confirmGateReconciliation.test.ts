import { describe, expect, it } from "vitest";

import {
  classifyConfirmUtterance,
  reconcileGateSignals,
  voteForUtterance,
  type GateVote,
} from "../src/main/agent/confirmGateReconciliation";

/**
 * Unit tests for the Confirm Gate's fail-safe reconciliation (M2-04, ported from v1
 * ticket 18). These are the acceptance-critical safety rules, pinned down as pure logic
 * with no chip, mic, or hotkey - in the style of `PushToTalkTracker` / `VoiceLoopMachine`:
 *
 *   - any cancel signal always beats a concurrent approve (cancel wins every race);
 *   - a voice approval counts only on an unambiguous affirmative;
 *   - anything ambiguous re-prompts and can never become a go on a consequential Action.
 */

describe("reconcileGateSignals - cancel always wins", () => {
  it("returns cancel when the only vote is cancel", () => {
    expect(reconcileGateSignals(["cancel"])).toBe("cancel");
  });

  it("returns cancel when a cancel races a concurrent approve (both present)", () => {
    expect(reconcileGateSignals(["approve", "cancel"])).toBe("cancel");
    // Order must not matter: cancel dominates regardless of which arrived first.
    expect(reconcileGateSignals(["cancel", "approve"])).toBe("cancel");
  });

  it("returns cancel even amid several approves and abstains", () => {
    expect(reconcileGateSignals(["approve", "abstain", "approve", "cancel"])).toBe("cancel");
  });
});

describe("reconcileGateSignals - approve only on an explicit approve, nothing else", () => {
  it("returns approve when an approve is present and no cancel", () => {
    expect(reconcileGateSignals(["approve"])).toBe("approve");
    expect(reconcileGateSignals(["abstain", "approve"])).toBe("approve");
  });
});

describe("reconcileGateSignals - re-prompt when nothing is decisive", () => {
  it("re-prompts on an empty set (no answer yet)", () => {
    expect(reconcileGateSignals([])).toBe("reprompt");
  });

  it("re-prompts when every vote abstains (only ambiguous input so far)", () => {
    expect(reconcileGateSignals(["abstain"])).toBe("reprompt");
    expect(reconcileGateSignals(["abstain", "abstain"])).toBe("reprompt");
  });
});

describe("classifyConfirmUtterance - unambiguous affirmatives", () => {
  it.each([
    "yes",
    "Yes.",
    "yeah",
    "yep",
    "sure",
    "ok",
    "okay",
    "go ahead",
    "yes go ahead",
    "go",
    "do it",
    "proceed",
    "please do",
    "sounds good",
  ])("classifies %j as affirmative", (transcript) => {
    expect(classifyConfirmUtterance(transcript)).toBe("affirmative");
  });
});

describe("classifyConfirmUtterance - clear negatives (and mixed replies fail safe)", () => {
  it.each([
    "no",
    "No!",
    "nope",
    "nah",
    "stop",
    "no stop",
    "cancel",
    "don't",
    "dont",
    "abort",
    "never mind",
    "nevermind",
  ])("classifies %j as negative", (transcript) => {
    expect(classifyConfirmUtterance(transcript)).toBe("negative");
  });

  it("treats a reply carrying any negative cue as negative, never affirmative (fail safe)", () => {
    // A muddled "yeah, no, don't" contains a clear negative: it must never approve.
    expect(classifyConfirmUtterance("yeah no don't")).toBe("negative");
    expect(classifyConfirmUtterance("actually no, stop")).toBe("negative");
  });
});

describe("classifyConfirmUtterance - ambiguous never approves", () => {
  it.each([
    "",
    "   ",
    "um",
    "uh maybe",
    "not sure",
    "what",
    "wait",
    "hold on let me think",
    "the quick brown fox",
  ])("classifies %j as ambiguous", (transcript) => {
    expect(classifyConfirmUtterance(transcript)).toBe("ambiguous");
  });

  it("does not mistake words that merely contain a cue for that cue", () => {
    // "know" contains "no", "goes" contains "go" - token matching must not fire on these.
    expect(classifyConfirmUtterance("you know")).toBe("ambiguous");
    expect(classifyConfirmUtterance("it goes there")).toBe("ambiguous");
  });
});

describe("voteForUtterance - maps a voice intent onto a reconciliation vote", () => {
  it("maps affirmative -> approve, negative -> cancel, ambiguous -> abstain", () => {
    const cases: Array<[Parameters<typeof voteForUtterance>[0], GateVote]> = [
      ["affirmative", "approve"],
      ["negative", "cancel"],
      ["ambiguous", "abstain"],
    ];
    for (const [intent, vote] of cases) {
      expect(voteForUtterance(intent)).toBe(vote);
    }
  });

  it("an ambiguous utterance can never turn into an approve through reconciliation", () => {
    // The end-to-end fail-safe: an ambiguous voice reply alongside no other signal re-prompts.
    const vote = voteForUtterance(classifyConfirmUtterance("uhh I guess maybe"));
    expect(reconcileGateSignals([vote])).toBe("reprompt");
  });
});
