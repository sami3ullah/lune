import { z } from "zod";

// The Shell's own main -> renderer IPC for Kokoro speech playback (ticket 09), kept
// separate from @lune/shared for the same reason as overlay-control and
// screen-permission: these messages never reach the Core. Synthesis happens in the
// main process (in-process onnxruntime-node); the resulting WAV clips are handed to a
// renderer to actually play, because only a renderer has an audio output element.
// They stay out of the Core contract but are still fully zod-typed so nothing untyped
// crosses the process boundary (developer story 46).
//
// The main process sentence-streams: it sends each synthesized sentence as a `clip`
// as soon as it is ready (tagged with a monotonic sequence so the player preserves
// order), sends `turn-complete` once the last sentence has been synthesized, and
// sends `stop` to abort playback immediately (a failed turn, or later, barge-in).

/** main -> renderer: every speech-playback event rides this one channel. */
export const SPEECH_EVENT_CHANNEL = "lune:speech:event";

/**
 * One speech-playback event, main -> the Pill renderer (Lune's always-present home
 * surface, so it owns the audio element). A turn emits zero or more `clip`s in
 * `sequence` order, then exactly one `turn-complete` once no more clips are coming, so
 * the player can return to idle after the queue drains. `stop` clears the queue and
 * halts playback at once, regardless of turn.
 */
export const SpeechEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("clip"),
    /** The chat turn this clip belongs to (lets a stale turn's clips be ignored). */
    turnId: z.string().min(1),
    /** Monotonic per-turn order index; the player plays clips in ascending sequence. */
    sequence: z.number().int().nonnegative(),
    /** Base64-encoded audio bytes (no `data:` prefix). */
    audioBase64: z.string().min(1),
    /** The clip's MIME type, e.g. `audio/wav`. */
    contentType: z.string().min(1),
  }),
  z.object({
    type: z.literal("turn-complete"),
    turnId: z.string().min(1),
  }),
  z.object({
    type: z.literal("stop"),
  }),
]);
export type SpeechEvent = z.infer<typeof SpeechEventSchema>;
