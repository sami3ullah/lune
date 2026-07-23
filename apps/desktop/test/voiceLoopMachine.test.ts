import { describe, expect, it } from "vitest";

import { VoiceLoopMachine } from "../src/main/voice/voiceLoopMachine";

/**
 * Unit tests for the push-to-talk voice-loop state machine (ticket 11): the pure phase
 * transitions of one hold-speak-release interaction and the Barge-in decision. These
 * pin down the acceptance-critical behaviour - a full round trip, an empty clip, and
 * Barge-in from every interruptible phase - without any mic, Vendor, or speaker.
 */

describe("VoiceLoopMachine - a normal hold-speak-release round trip", () => {
  it("goes idle -> listening -> transcribing -> answering -> idle", () => {
    const machine = new VoiceLoopMachine();
    expect(machine.phase).toBe("idle");

    // Hold the hotkey: recording begins, nothing to interrupt.
    expect(machine.hotkeyPressed()).toEqual({ startRecording: true, bargeIn: false });
    expect(machine.phase).toBe("listening");

    // Release: the clip is finalized for transcription.
    expect(machine.hotkeyReleased()).toEqual({ stopRecording: true });
    expect(machine.phase).toBe("transcribing");

    // A non-empty transcript becomes a turn.
    expect(machine.transcribed(true)).toEqual({ submitTurn: true });
    expect(machine.phase).toBe("answering");

    // The turn finishes: back to idle for the next interaction.
    machine.turnEnded();
    expect(machine.phase).toBe("idle");
  });

  it("returns to idle without a turn when the clip transcribes to nothing (silence)", () => {
    const machine = new VoiceLoopMachine();
    machine.hotkeyPressed();
    machine.hotkeyReleased();
    expect(machine.transcribed(false)).toEqual({ submitTurn: false });
    expect(machine.phase).toBe("idle");
  });
});

describe("VoiceLoopMachine - Barge-in", () => {
  it("interrupts an in-flight answer: abort + stop speech + start a new recording", () => {
    const machine = new VoiceLoopMachine();
    machine.hotkeyPressed();
    machine.hotkeyReleased();
    machine.transcribed(true);
    expect(machine.phase).toBe("answering");

    // Pressing the hotkey mid-answer is Barge-in.
    expect(machine.hotkeyPressed()).toEqual({ startRecording: true, bargeIn: true });
    expect(machine.phase).toBe("listening");
  });

  it("interrupts a pending transcription too (press before the transcript returns)", () => {
    const machine = new VoiceLoopMachine();
    machine.hotkeyPressed();
    machine.hotkeyReleased();
    expect(machine.phase).toBe("transcribing");

    expect(machine.hotkeyPressed()).toEqual({ startRecording: true, bargeIn: true });
    expect(machine.phase).toBe("listening");
  });

  it("ignores a transcript that arrives after Barge-in already moved the loop on", () => {
    const machine = new VoiceLoopMachine();
    machine.hotkeyPressed();
    machine.hotkeyReleased();
    // Barge-in mid-transcription: now listening to a fresh clip.
    machine.hotkeyPressed();
    // The superseded first clip's transcript lands late - it must not start a turn.
    expect(machine.transcribed(true)).toEqual({ submitTurn: false });
    expect(machine.phase).toBe("listening");
  });

  it("interrupts a turn started from the Chat Panel (typed turn that is speaking)", () => {
    const machine = new VoiceLoopMachine();
    // A typed turn begins answering while the voice loop was idle.
    machine.externalTurnStarted();
    expect(machine.phase).toBe("answering");

    // Pressing the hotkey during its playback is Barge-in, just like a voice turn.
    expect(machine.hotkeyPressed()).toEqual({ startRecording: true, bargeIn: true });
    expect(machine.phase).toBe("listening");
  });
});

describe("VoiceLoopMachine - guards against out-of-order and no-op events", () => {
  it("does not re-start recording on a second press while already listening", () => {
    const machine = new VoiceLoopMachine();
    machine.hotkeyPressed();
    expect(machine.hotkeyPressed()).toEqual({ startRecording: false, bargeIn: false });
    expect(machine.phase).toBe("listening");
  });

  it("ignores a release that does not end a listening hold", () => {
    const machine = new VoiceLoopMachine();
    // A release with nothing being recorded is a no-op.
    expect(machine.hotkeyReleased()).toEqual({ stopRecording: false });
    expect(machine.phase).toBe("idle");
  });

  it("reset returns to idle from any phase (e.g. the mic failed while still listening)", () => {
    const machine = new VoiceLoopMachine();
    machine.hotkeyPressed(); // listening - a capture error can land here, before any release
    machine.reset();
    expect(machine.phase).toBe("idle");
    // A fresh interaction works normally after the reset.
    expect(machine.hotkeyPressed()).toEqual({ startRecording: true, bargeIn: false });
    expect(machine.phase).toBe("listening");
  });

  it("ignores externalTurnStarted unless idle, and a stale turnEnded outside answering", () => {
    const machine = new VoiceLoopMachine();
    machine.hotkeyPressed(); // listening
    machine.externalTurnStarted(); // ignored - the voice flow owns this interaction
    expect(machine.phase).toBe("listening");

    // A late completion from a superseded turn must not reset a fresh listening phase.
    machine.turnEnded();
    expect(machine.phase).toBe("listening");
  });
});
