import { describe, expect, it, vi } from "vitest";

import { VoiceLoopController } from "../src/main/voice/voiceLoopController";
import type { PushToTalkMonitor } from "../src/main/voice/pushToTalkMonitor";
import type { PillActivityState } from "../src/main/voice/voiceLoopController";
import type { VoiceRecordCommand } from "../src/ipc/voiceInput";

/**
 * Barge-in / stop-speaking on the push-to-talk loop. The reported bug: pressing the hotkey
 * to start a new phrase did not silence Lune when she was still talking. Root cause - the
 * machine returns to `idle` when speech *synthesis* finishes, but Kokoro keeps playing the
 * audio tail in the renderer after that, so a press in that window is a plain
 * `idle -> listening` start (not a barge-in) and `stopSpeech` was gated to barge-in only.
 * The fix silences speech on every recording start (a no-op when nothing is playing), so a
 * press always cuts playback. The pure phase transitions live in `voiceLoopMachine.test.ts`.
 */

interface Harness {
  press: () => void;
  release: () => void;
  clip: (turnId: string) => void;
  commands: VoiceRecordCommand[];
  pillActivity: PillActivityState[];
  stopSpeech: ReturnType<typeof vi.fn>;
}

function makeHarness(runVoiceTurnSpoke: boolean): Harness {
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
  const pillActivity: PillActivityState[] = [];
  const stopSpeech = vi.fn();
  let idCounter = 0;
  const controller = new VoiceLoopController({
    monitor,
    isTranscriptionReady: () => true,
    transcribe: async () => "how do i unsubscribe",
    sendRecordCommand: (command) => commands.push(command),
    setPillActivity: (state) => pillActivity.push(state),
    stopSpeech,
    overlayListenStart: () => {},
    overlayListenLevel: () => {},
    overlayListenEnd: () => {},
    runVoiceTurn: async () => ({ spoke: runVoiceTurnSpoke }),
    announceNoSpeech: async () => ({ spoke: false }),
    generateId: () => `id-${(idCounter += 1)}`,
    decodeBase64: () => new Uint8Array(),
  });
  controller.start();

  return {
    press: () => onPressed(),
    release: () => onReleased(),
    clip: (turnId) => controller.handleRecordEvent({ type: "clip", turnId, audioBase64: "" }),
    commands,
    pillActivity,
    stopSpeech,
  };
}

describe("VoiceLoopController - stop speaking on press", () => {
  it("silences speech on a press, before listening starts", () => {
    const harness = makeHarness(false);

    harness.press();

    expect(harness.stopSpeech).toHaveBeenCalledTimes(1);
    expect(harness.commands.some((command) => command.type === "start")).toBe(true);
  });

  it("silences speech on a press taken after a turn ended but its audio is still playing", async () => {
    // A turn where the machine has returned to idle (synthesis done) while playback lingers.
    const harness = makeHarness(false);

    // Run one full utterance: hold, release, and let the transcribed clip answer as a turn.
    harness.press();
    harness.release();
    harness.clip("id-1");

    // The turn resolving returns the machine to idle (a silent turn idles the Pill here).
    await vi.waitFor(() => expect(harness.pillActivity).toContain("idle"));

    // Now the machine is idle but Lune could still be talking. A press must still cut it.
    harness.stopSpeech.mockClear();
    harness.press();

    expect(harness.stopSpeech).toHaveBeenCalledTimes(1);
  });
});
