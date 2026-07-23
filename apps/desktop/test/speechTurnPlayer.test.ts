import { describe, expect, it } from "vitest";
import type { SpeechCapability } from "@lune/core";

import { createSpeechTurnPlayer } from "../src/main/speech/speechTurnPlayer";
import type { SpeechEvent } from "../src/ipc/speechPlayback";

/**
 * Tests for the per-turn speech player (ticket 09): it sentence-streams the answer,
 * synthesizing one sentence at a time in order and emitting each as a `clip` the
 * moment its audio is ready, so the first audio starts while later sentences are
 * still being generated (user story 21). The synthesis boundary and the event sink
 * are injected, so ordering/pipelining is asserted against fakes.
 */

/** A synthesis fake whose calls are individually resolvable, to observe pipelining. */
function makeGatedSpeech(): {
  speech: SpeechCapability;
  calls: string[];
  resolveNext: (bytes: number[]) => void;
} {
  const calls: string[] = [];
  const pendingResolvers: Array<(audio: Uint8Array) => void> = [];
  const speech: SpeechCapability = {
    isReady: () => true,
    synthesize: (text: string) => {
      calls.push(text);
      return new Promise((resolve) => {
        pendingResolvers.push((audio) => resolve({ audio, contentType: "audio/wav" }));
      });
    },
  };
  const resolveNext = (bytes: number[]) => {
    const resolver = pendingResolvers.shift();
    if (resolver === undefined) {
      throw new Error("no pending synthesis to resolve");
    }
    resolver(new Uint8Array(bytes));
  };
  return { speech, calls, resolveNext };
}

/** Yields to the event loop so a resolved synthesis promise's `.then` chain runs. */
const flushPendingWork = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const encodeBase64 = (audio: Uint8Array) => Buffer.from(audio).toString("base64");

describe("createSpeechTurnPlayer", () => {
  it("synthesizes one sentence at a time, emitting clips in order with ascending sequence", async () => {
    const { speech, calls, resolveNext } = makeGatedSpeech();
    const events: SpeechEvent[] = [];
    const player = createSpeechTurnPlayer({
      speech,
      turnId: "turn-1",
      sendEvent: (event) => events.push(event),
      encodeBase64,
    });

    // Two complete sentences arrive in one snapshot.
    player.pushAnswerText("One. Two. ");
    await flushPendingWork();

    // Only the first sentence is in flight - the player does not wait for the whole
    // answer, and processes sentences one at a time (pipelining).
    expect(calls).toEqual(["One."]);
    expect(events).toHaveLength(0);

    resolveNext([1, 1]);
    await flushPendingWork();
    // First clip emitted; second sentence now synthesizing.
    expect(events).toEqual([
      { type: "clip", turnId: "turn-1", sequence: 0, audioBase64: encodeBase64(new Uint8Array([1, 1])), contentType: "audio/wav" },
    ]);
    expect(calls).toEqual(["One.", "Two."]);

    resolveNext([2, 2]);
    await flushPendingWork();
    expect(events[1]).toEqual({
      type: "clip",
      turnId: "turn-1",
      sequence: 1,
      audioBase64: encodeBase64(new Uint8Array([2, 2])),
      contentType: "audio/wav",
    });
  });

  it("flushes the trailing sentence and emits turn-complete after the queue drains", async () => {
    const { speech, calls, resolveNext } = makeGatedSpeech();
    const events: SpeechEvent[] = [];
    const player = createSpeechTurnPlayer({
      speech,
      turnId: "turn-2",
      sendEvent: (event) => events.push(event),
      encodeBase64,
    });

    player.pushAnswerText("Hello there. See that");
    await flushPendingWork();
    expect(calls).toEqual(["Hello there."]);

    // Finish with the unterminated remainder plus a trailing point tag (dropped).
    const finished = player.finish("Hello there. See that button [POINT:1,2:btn:screen1]");
    resolveNext([9]); // "Hello there."
    await flushPendingWork();
    resolveNext([8]); // "See that button"
    await finished;

    expect(calls).toEqual(["Hello there.", "See that button"]);
    expect(events.map((event) => event.type)).toEqual(["clip", "clip", "turn-complete"]);
    expect(events.at(-1)).toEqual({ type: "turn-complete", turnId: "turn-2" });
  });

  it("emits turn-complete immediately when nothing was speakable", async () => {
    const { speech } = makeGatedSpeech();
    const events: SpeechEvent[] = [];
    const player = createSpeechTurnPlayer({
      speech,
      turnId: "turn-3",
      sendEvent: (event) => events.push(event),
      encodeBase64,
    });

    // Only a point tag - nothing to speak.
    await player.finish("[POINT:1,2:btn:screen1]");
    expect(events).toEqual([{ type: "turn-complete", turnId: "turn-3" }]);
  });

  it("stops the turn's speech (and emits no turn-complete) when a synthesis fails", async () => {
    const errors: unknown[] = [];
    const speech: SpeechCapability = {
      isReady: () => true,
      synthesize: () => Promise.reject(new Error("synthesis blew up")),
    };
    const events: SpeechEvent[] = [];
    const player = createSpeechTurnPlayer({
      speech,
      turnId: "turn-4",
      sendEvent: (event) => events.push(event),
      encodeBase64,
      onError: (error) => errors.push(error),
    });

    await player.finish("This will fail.");

    expect(errors).toHaveLength(1);
    expect(events).toHaveLength(0);
  });
});
