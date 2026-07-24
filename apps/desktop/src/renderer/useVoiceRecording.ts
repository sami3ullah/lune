import { useEffect, useRef } from "react";

// The renderer half of push-to-talk recording (ticket 11), mounted once in the
// always-present Pill - the one surface that owns audio (it already plays Kokoro clips)
// and the only place with `navigator.mediaDevices`. The main process owns the global
// hotkey, so it drives recording over IPC: on `start` this captures the mic, streams the
// live input level back for the Overlay waveform, and on `stop` encodes the captured
// audio to a 16 kHz mono WAV and hands it back for the Core to transcribe. `cancel`
// (Barge-in, or a mic error) tears the recording down with no clip.
//
// Capture is raw PCM via the Web Audio graph (not MediaRecorder, whose WebM/Opus output
// whisper does not accept): a 16 kHz AudioContext resamples the mic, and a processor
// node accumulates mono float samples while reporting each buffer's amplitude. This is
// untested renderer edge - the voice loop's logic lives in the tested main-process
// modules; this only moves bytes.

/** whisper wants 16 kHz mono; requesting it on the context makes the graph resample for us. */
const TARGET_SAMPLE_RATE_HZ = 16_000;

/** Processor buffer size: ~64 ms at 16 kHz, a lively-enough cadence for the waveform. */
const CAPTURE_BUFFER_SIZE = 1024;

/** Scales RMS amplitude to a 0..1 waveform level; speech rarely approaches full-scale. */
const LEVEL_GAIN = 4;

/**
 * The peak level a recording must reach to count as speech. Below this the clip is treated
 * as silence and never transcribed (whisper would only hallucinate a phrase from silence -
 * "thank you", "you're welcome" - which then gets answered). Real speech clears this
 * easily; only true silence / a barely-open mic falls under it.
 */
const SPEECH_PEAK_LEVEL_THRESHOLD = 0.06;

/** The live capture graph for one recording, held in a ref so it survives re-renders. */
interface ActiveRecording {
  turnId: string;
  stream: MediaStream;
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  processorNode: ScriptProcessorNode;
  /** Captured mono float chunks, concatenated into the WAV on stop. */
  chunks: Float32Array[];
  sampleRate: number;
  /** The loudest input level (0..1) seen during the recording, to tell speech from silence. */
  peakLevel: number;
}

/**
 * A recording whose `getUserMedia` has not resolved yet. The OS mic prompt can hold
 * `getUserMedia` open for seconds on first use, and the user often releases (or
 * Barge-in cancels) before it resolves - so a stop/cancel that lands during this window
 * is remembered here and honored the moment the stream arrives, rather than dropped
 * (which would strand the mic open and the loop stuck).
 */
interface PendingStart {
  turnId: string;
  /** A stop arrived before the stream resolved: finalize immediately once it does. */
  stopRequested: boolean;
  /** A cancel/supersede arrived before the stream resolved: discard it once it does. */
  canceled: boolean;
}

/** Encodes captured mono float samples as a 16-bit PCM WAV (the format whisper reads). */
function encodeWav(samples: Float32Array, sampleRateHz: number): Uint8Array {
  const bytesPerSample = 2;
  const dataByteLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataByteLength, true);
  let writeOffset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(writeOffset, Math.round(clamped * 32767), true);
    writeOffset += bytesPerSample;
  }
  return new Uint8Array(buffer);
}

/** Base64-encodes bytes for the typed IPC payload (chunked so a long clip never overflows the call stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function useVoiceRecording(): void {
  // The active recording (or null). A ref, not state, so the async capture callbacks
  // read/write it without re-rendering the Pill or re-subscribing the command listener.
  const recordingRef = useRef<ActiveRecording | null>(null);
  // The recording whose getUserMedia is still resolving, so a stop/cancel arriving
  // during the mic prompt is not lost (see PendingStart).
  const pendingStartRef = useRef<PendingStart | null>(null);

  useEffect(() => {
    /** Tears down the capture graph and releases the mic; safe to call repeatedly. */
    const teardown = (recording: ActiveRecording): void => {
      recording.processorNode.onaudioprocess = null;
      recording.processorNode.disconnect();
      recording.sourceNode.disconnect();
      for (const track of recording.stream.getTracks()) {
        track.stop();
      }
      void recording.audioContext.close().catch(() => {});
    };

    /** Stops a resolved MediaStream's tracks (used when a pending start was abandoned). */
    const stopStreamTracks = (stream: MediaStream): void => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    };

    const startRecording = async (turnId: string): Promise<void> => {
      // A start while something is still recording (should not happen - the loop stops
      // first) discards the stale one so the mic is never double-opened.
      if (recordingRef.current !== null) {
        teardown(recordingRef.current);
        recordingRef.current = null;
      }
      // A start supersedes any earlier pending start still awaiting the mic prompt.
      if (pendingStartRef.current !== null) {
        pendingStartRef.current.canceled = true;
      }
      const pending: PendingStart = { turnId, stopRequested: false, canceled: false };
      pendingStartRef.current = pending;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        // Only report the failure if this start is still the one the loop wants; a
        // cancel/supersede during the prompt means the caller already moved on.
        if (pendingStartRef.current === pending) {
          pendingStartRef.current = null;
        }
        if (!pending.canceled) {
          window.lune.voice.sendRecordEvent({
            type: "error",
            turnId,
            reason: error instanceof Error ? error.message : "Microphone is unavailable",
          });
        }
        return;
      }

      // The stream resolved. If a newer start superseded this one, or a cancel landed
      // during the prompt, release the mic immediately and set nothing up.
      if (pendingStartRef.current !== pending || pending.canceled) {
        stopStreamTracks(stream);
        return;
      }
      pendingStartRef.current = null;

      const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE_HZ });
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
      const recording: ActiveRecording = {
        turnId,
        stream,
        audioContext,
        sourceNode,
        processorNode,
        chunks: [],
        sampleRate: audioContext.sampleRate,
        peakLevel: 0,
      };

      processorNode.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        // Copy: the input buffer is reused by the audio thread after this callback.
        recording.chunks.push(new Float32Array(input));
        // Report the buffer's amplitude (RMS) for the waveform, scaled and clamped.
        let sumOfSquares = 0;
        for (let index = 0; index < input.length; index += 1) {
          sumOfSquares += input[index]! * input[index]!;
        }
        const rms = Math.sqrt(sumOfSquares / input.length);
        const level = Math.min(1, rms * LEVEL_GAIN);
        recording.peakLevel = Math.max(recording.peakLevel, level);
        window.lune.voice.sendRecordEvent({ type: "level", turnId, level });
        // Emit silence downstream: the node must be connected to run, but the mic must
        // never be echoed to the speakers.
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      // Push-to-talk is driven by a global OS hotkey, not a DOM gesture, so Chromium's
      // autoplay policy can leave a freshly-created AudioContext "suspended" - the
      // processor never fires and the clip comes back empty (whisper then rejects it with
      // HTTP 400). Resume it explicitly so capture starts regardless of how it was
      // triggered. Fire-and-forget so a stop arriving mid-resume is never lost.
      void audioContext.resume().catch(() => {});
      recordingRef.current = recording;

      // A stop that arrived while the mic prompt was still open finalizes now that the
      // recording exists (yielding a near-empty clip - the user released almost at once).
      if (pending.stopRequested) {
        stopRecording(turnId);
      }
    };

    const stopRecording = (turnId: string): void => {
      const recording = recordingRef.current;
      if (recording === null || recording.turnId !== turnId) {
        // The recording may still be awaiting the mic prompt: remember the stop so it is
        // honored the moment the stream resolves, rather than dropped.
        if (pendingStartRef.current !== null && pendingStartRef.current.turnId === turnId) {
          pendingStartRef.current.stopRequested = true;
        }
        return;
      }
      recordingRef.current = null;
      teardown(recording);

      const totalLength = recording.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const samples = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of recording.chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      // Nothing was captured, or the clip never rose above the silence floor: don't send it
      // to whisper (which would either 400 on empty audio or hallucinate a phrase from
      // silence). Report `silent` so the loop can give the user a friendly nudge instead.
      if (totalLength === 0 || recording.peakLevel < SPEECH_PEAK_LEVEL_THRESHOLD) {
        window.lune.voice.sendRecordEvent({ type: "silent", turnId });
        return;
      }

      const wav = encodeWav(samples, recording.sampleRate);
      window.lune.voice.sendRecordEvent({ type: "clip", turnId, audioBase64: bytesToBase64(wav) });
    };

    const cancelRecording = (): void => {
      // Cancel a pending start too, so a recording still awaiting the mic prompt is
      // discarded (the mic released) once it resolves rather than opened for nothing.
      if (pendingStartRef.current !== null) {
        pendingStartRef.current.canceled = true;
      }
      const recording = recordingRef.current;
      if (recording === null) {
        return;
      }
      recordingRef.current = null;
      teardown(recording);
    };

    const unsubscribe = window.lune.voice.onRecordCommand((command) => {
      switch (command.type) {
        case "start":
          void startRecording(command.turnId);
          break;
        case "stop":
          stopRecording(command.turnId);
          break;
        case "cancel":
          cancelRecording();
          break;
      }
    });

    return () => {
      unsubscribe();
      // Abandon a start still awaiting the mic prompt so its stream is released on arrival.
      if (pendingStartRef.current !== null) {
        pendingStartRef.current.canceled = true;
      }
      if (recordingRef.current !== null) {
        teardown(recordingRef.current);
        recordingRef.current = null;
      }
    };
  }, []);
}
