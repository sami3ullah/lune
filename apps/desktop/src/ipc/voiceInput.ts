import { z } from "zod";

// The Shell's own renderer <-> main IPC for the push-to-talk voice loop (ticket 11).
// Like speech-playback, overlay, and screen-permission, these messages never reach the
// Core: capturing the microphone and reflecting the listening/thinking state on the Pill
// are pure OS-and-pixels concerns a future HTTP adapter fronting the Core would never
// carry. They stay out of @lune/shared (the Core contract) but are still fully zod-typed
// so nothing untyped crosses the process boundary (developer story 46). The microphone
// *permission* flow is owned by ticket 14's `ipc/micPermission.ts` (shared with the
// onboarding permissions step); the voice loop simply consumes it.
//
// Recording lives in the Pill renderer - the one surface that owns audio (it already
// plays Kokoro clips), and the only place with `navigator.mediaDevices`. The main
// process owns the hold-to-talk hotkey, so it drives recording start/stop over IPC; the
// Pill streams back the live input level (for the waveform) and, on stop, the finished
// WAV clip for the Core to transcribe. Barge-in cancels an in-progress recording.

/** main -> Pill: start/stop/cancel one microphone recording (the hotkey drives these). */
export const VOICE_RECORD_COMMAND_CHANNEL = "lune:voice:record-command";

/** Pill -> main: the live input level, the finished clip, or a capture error. */
export const VOICE_RECORD_EVENT_CHANNEL = "lune:voice:record-event";

/** main -> Pill: the voice-loop activity state to show on the Pill (idle/listening/thinking). */
export const VOICE_PILL_ACTIVITY_CHANNEL = "lune:voice:pill-activity";

/**
 * One recording command, main -> the Pill renderer. `start`/`stop` carry the turn id so
 * a late event from a superseded recording (after a Barge-in) can be ignored; `cancel`
 * aborts the current recording outright with no clip (Barge-in, or a mic error upstream).
 */
export const VoiceRecordCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), turnId: z.string().min(1) }),
  z.object({ type: z.literal("stop"), turnId: z.string().min(1) }),
  z.object({ type: z.literal("cancel") }),
]);
export type VoiceRecordCommand = z.infer<typeof VoiceRecordCommandSchema>;

/**
 * One recording event, the Pill renderer -> main. `level` streams the current input
 * amplitude (0..1) for the live waveform; `clip` delivers the finished recording as a
 * base64 WAV once the hold is released; `error` reports a capture/permission failure so
 * the turn ends cleanly instead of hanging. Each carries its recording's turn id.
 */
export const VoiceRecordEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("level"),
    turnId: z.string().min(1),
    /** Current input amplitude, normalized to 0..1, for the waveform. */
    level: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("clip"),
    turnId: z.string().min(1),
    /** The recorded clip as base64-encoded 16 kHz mono WAV (no `data:` prefix). */
    audioBase64: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    turnId: z.string().min(1),
    /** A short human-readable reason (mic denied, no device, capture failed). */
    reason: z.string().min(1),
  }),
]);
export type VoiceRecordEvent = z.infer<typeof VoiceRecordEventSchema>;

/**
 * The voice-loop activity state shown on the Pill. `speaking` is driven separately by
 * Kokoro playback (`useSpeechPlayback`); this covers the states the voice loop owns -
 * idle, listening (recording), and thinking (transcribing / awaiting the first audio).
 */
export const VoicePillActivitySchema = z.object({
  state: z.enum(["idle", "listening", "thinking"]),
});
export type VoicePillActivity = z.infer<typeof VoicePillActivitySchema>;
