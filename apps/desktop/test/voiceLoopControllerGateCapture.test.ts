import { describe, expect, it, vi } from "vitest";

import { VoiceLoopController } from "../src/main/voice/voiceLoopController";
import type { PushToTalkMonitor } from "../src/main/voice/pushToTalkMonitor";
import type { VoiceRecordCommand } from "../src/ipc/voiceInput";

/**
 * Tests for Confirm Gate voice capture in the push-to-talk loop (M2-04): while a gate is
 * open, the hotkey must answer the gate - hold to speak, release to transcribe - and must
 * NOT barge-in (cancel) the Screen Agent run the gate is guarding. The turn machine and its
 * barge-in path are covered by `voiceLoopMachine.test.ts`; here we pin down the gate branch
 * against fakes.
 */

interface Harness {
  controller: VoiceLoopController;
  press: () => void;
  release: () => void;
  commands: VoiceRecordCommand[];
  gateAnswers: string[];
}

function makeHarness(options: { transcript?: string; transcriptionReady?: boolean } = {}): Harness {
  let onPressed = (): void => {};
  let onReleased = (): void => {};
  const monitor: PushToTalkMonitor = {
    start: (handlers: { onPressed: () => void; onReleased: () => void }) => {
      onPressed = handlers.onPressed;
      onReleased = handlers.onReleased;
    },
    stop: () => {},
  } as unknown as PushToTalkMonitor;

  const commands: VoiceRecordCommand[] = [];
  let idCounter = 0;
  const controller = new VoiceLoopController({
    monitor,
    isTranscriptionReady: () => options.transcriptionReady ?? true,
    transcribe: async () => options.transcript ?? "yes go ahead",
    sendRecordCommand: (command) => commands.push(command),
    setPillActivity: () => {},
    stopSpeech: () => {},
    overlayListenStart: () => {},
    overlayListenLevel: () => {},
    overlayListenEnd: () => {},
    runVoiceTurn: async () => ({ spoke: false }),
    announceNoSpeech: async () => ({ spoke: false }),
    generateId: () => `id-${(idCounter += 1)}`,
    decodeBase64: () => new Uint8Array(),
  });
  controller.start();

  const gateAnswers: string[] = [];
  // The controller wires the monitor handlers on start(); expose them via the closures above.
  return {
    controller,
    press: () => onPressed(),
    release: () => onReleased(),
    commands,
    gateAnswers,
  };
}

describe("VoiceLoopController - Confirm Gate voice capture", () => {
  it("does not barge-in the guarded run when the hotkey answers an open gate", () => {
    const harness = makeHarness();
    // A Screen Agent run is registered as an external turn, so a normal press would barge-in.
    const runAbort = new AbortController();
    const abortSpy = vi.spyOn(runAbort, "abort");
    harness.controller.noteExternalTurnStarted(runAbort);

    const close = harness.controller.openConfirmGateCapture((transcript) =>
      harness.gateAnswers.push(transcript),
    );

    harness.press();
    // The run the gate guards must NOT be aborted by answering the gate.
    expect(abortSpy).not.toHaveBeenCalled();
    expect(runAbort.signal.aborted).toBe(false);
    // A recording did start (to capture the spoken answer).
    expect(harness.commands.some((command) => command.type === "start")).toBe(true);

    close();
  });

  it("transcribes the released hold and delivers the text to the gate", async () => {
    const harness = makeHarness({ transcript: "yes go ahead" });
    harness.controller.openConfirmGateCapture((transcript) => harness.gateAnswers.push(transcript));

    harness.press();
    const startCommand = harness.commands.find((command) => command.type === "start");
    expect(startCommand).toBeDefined();
    harness.release();

    // The Pill sends the finished clip back on the gate recording's id.
    harness.controller.handleRecordEvent({
      type: "clip",
      turnId: startCommand!.turnId,
      audioBase64: "",
    });
    await vi.waitFor(() => expect(harness.gateAnswers).toEqual(["yes go ahead"]));
  });

  it("delivers an empty transcript for a silent gate hold (the gate re-prompts, never proceeds)", async () => {
    const harness = makeHarness();
    harness.controller.openConfirmGateCapture((transcript) => harness.gateAnswers.push(transcript));

    harness.press();
    const startCommand = harness.commands.find((command) => command.type === "start");
    harness.controller.handleRecordEvent({ type: "silent", turnId: startCommand!.turnId });

    expect(harness.gateAnswers).toEqual([""]);
  });

  it("closing capture stops an in-flight gate recording", () => {
    const harness = makeHarness();
    const close = harness.controller.openConfirmGateCapture(() => {});

    harness.press();
    harness.commands.length = 0; // ignore the start command
    close();

    expect(harness.commands.some((command) => command.type === "stop")).toBe(true);
  });
});
