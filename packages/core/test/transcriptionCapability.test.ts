import { describe, expect, it } from "vitest";

import {
  createTranscriptionCapability,
  EmptyTranscriptionAudioError,
  TranscriptionNotReadyError,
} from "../src/transcription/transcriptionCapability.js";
import type { TranscribeAudio } from "../src/transcription/whisperTranscription.js";

/**
 * Tests for the Transcription Capability - the Core public API the Electron main
 * process calls directly. This is the successor of v1's HTTP-driven
 * `localTranscription.test.ts` (real server + `/transcribe` route), with HTTP
 * removed: the same behaviours (batch transcript in one shot, not-ready gating,
 * empty-clip rejection, empty transcript for silence) are exercised straight against
 * the Capability's method, with the whisper Runtime seam stubbed - no binary or model
 * weights needed. This is the record -> transcribe -> transcript batch path.
 */

const CANNED_AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]); // "RIFF.."

describe("TranscriptionCapability.transcribe (local batch-on-release)", () => {
  it("transcribes the recorded clip in one shot and returns the transcript", async () => {
    const receivedAudioLengths: number[] = [];
    const transcribe: TranscribeAudio = async (audioWav) => {
      receivedAudioLengths.push(audioWav.byteLength);
      return { text: "hello from whisper" };
    };
    const capability = createTranscriptionCapability({ isRuntimeReady: () => true, transcribe });

    const result = await capability.transcribe(CANNED_AUDIO);

    expect(result.text).toBe("hello from whisper");
    // The whole clip reached the Runtime exactly once (batch, not streaming).
    expect(receivedAudioLengths).toEqual([CANNED_AUDIO.byteLength]);
  });

  it("throws TranscriptionNotReadyError without calling the Runtime when whisper is not ready", async () => {
    let transcribeCalls = 0;
    const transcribe: TranscribeAudio = async () => {
      transcribeCalls += 1;
      return { text: "" };
    };
    const capability = createTranscriptionCapability({ isRuntimeReady: () => false, transcribe });

    await expect(capability.transcribe(CANNED_AUDIO)).rejects.toBeInstanceOf(TranscriptionNotReadyError);
    expect(transcribeCalls).toBe(0);
    expect(capability.isReady()).toBe(false);
  });

  it("throws EmptyTranscriptionAudioError for an empty clip, without calling the Runtime", async () => {
    let transcribeCalls = 0;
    const transcribe: TranscribeAudio = async () => {
      transcribeCalls += 1;
      return { text: "" };
    };
    const capability = createTranscriptionCapability({ isRuntimeReady: () => true, transcribe });

    await expect(capability.transcribe(new Uint8Array(0))).rejects.toBeInstanceOf(
      EmptyTranscriptionAudioError,
    );
    expect(transcribeCalls).toBe(0);
  });

  it("returns an empty transcript for silence (valid audio, no speech)", async () => {
    const transcribe: TranscribeAudio = async () => ({ text: "" });
    const capability = createTranscriptionCapability({ isRuntimeReady: () => true, transcribe });

    const result = await capability.transcribe(CANNED_AUDIO);

    expect(result.text).toBe("");
  });
});
