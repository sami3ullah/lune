import { VoiceLoopMachine } from "./voiceLoopMachine";
import type { PushToTalkMonitor } from "./pushToTalkMonitor";
import type { VoiceRecordCommand, VoiceRecordEvent } from "../../ipc/voiceInput";

// The push-to-talk orchestrator (ticket 11): it turns the global hotkey and the Pill's
// recording events into one conversational loop - hold to record, release to transcribe
// and answer, press mid-answer to Barge-in - by driving the pure `VoiceLoopMachine` and
// acting on the plans it returns. The machine owns the decision (tested); this owns the
// wiring (the untested edge): the mic recording IPC to the Pill, the whisper transcribe
// call, the Pill/Overlay state, and running the answer turn.
//
// Everything it touches is injected, so the moving parts (Overlay windows, the Pill
// send, whisper, the turn runner) stay in the main entry and this stays a thin
// coordinator. It guards every async step with a monotonically-increasing generation so
// a late transcript or a superseded turn - the natural fallout of Barge-in - can never
// answer for a recording the user already abandoned ("no overlap, no zombie audio").

/** The voice-loop activity state shown on the Pill (speaking is driven by Kokoro playback). */
export type PillActivityState = "idle" | "listening" | "thinking";

/** One voice turn to run: the transcript as the prompt, plus the Barge-in abort signal. */
export interface VoiceTurnRequest {
  turnId: string;
  prompt: string;
  signal: AbortSignal;
}

/** The outcome of a voice turn - whether it engaged speech, so the Pill knows who owns idle. */
export interface VoiceTurnResult {
  /** True if Kokoro spoke this turn; then playback returns the Pill to idle, not this loop. */
  spoke: boolean;
}

export interface VoiceLoopControllerDependencies {
  /** The global push-to-talk hotkey monitor (start/stop the OS hook). */
  monitor: PushToTalkMonitor;
  /** Whether whisper is ready to transcribe right now (weights provisioned + child healthy). */
  isTranscriptionReady: () => boolean;
  /** Transcribes a recorded WAV clip to text (the Core Transcription Capability). */
  transcribe: (audioWav: Uint8Array) => Promise<string>;
  /** Sends one recording command to the Pill renderer (which owns the mic). */
  sendRecordCommand: (command: VoiceRecordCommand) => void;
  /** Sets the Pill's voice-loop activity state (idle/listening/thinking). */
  setPillActivity: (state: PillActivityState) => void;
  /** Stops any in-flight Kokoro speech playback at once (Barge-in). */
  stopSpeech: () => void;
  /** Shows the listening waveform on the Overlay (resolving the cursor's display). */
  overlayListenStart: () => void;
  /** Streams the live mic level into the Overlay waveform. */
  overlayListenLevel: (level: number) => void;
  /** Ends the listening waveform on the Overlay. */
  overlayListenEnd: () => void;
  /** Runs one screen-aware voice turn end-to-end (stream + speak + persist); returns whether it spoke. */
  runVoiceTurn: (request: VoiceTurnRequest) => Promise<VoiceTurnResult>;
  /** Mints unique ids (recording ids, turn ids); injected so tests are deterministic. */
  generateId: () => string;
  /** Decodes the base64 WAV the Pill sends into bytes for the Core. */
  decodeBase64: (base64: string) => Uint8Array;
}

export class VoiceLoopController {
  private readonly machine = new VoiceLoopMachine();
  /**
   * Bumped on every hotkey press (each new recording). Async steps capture it and bail
   * if it has moved on, so a Barge-in cleanly discards the superseded recording's
   * transcript and turn.
   */
  private generation = 0;
  /** The id of the recording currently in flight, to ignore a stale recording's events. */
  private currentRecordingId: string | null = null;
  /**
   * The abort handles of every turn currently in flight (a voice turn, and/or a typed
   * Chat Panel turn). Barge-in aborts them all so nothing keeps streaming or speaking
   * behind the new recording, and a turn settles its own state only while still in this
   * set (a Barge-in removes it, so its late completion cannot reset a newer interaction).
   */
  private readonly activeTurnAborts = new Set<AbortController>();

  constructor(private readonly dependencies: VoiceLoopControllerDependencies) {}

  /** Starts listening for the global hotkey. */
  start(): void {
    this.dependencies.monitor.start({
      onPressed: () => this.onHotkeyPressed(),
      onReleased: () => this.onHotkeyReleased(),
    });
  }

  /** Stops the global hotkey hook. */
  stop(): void {
    this.dependencies.monitor.stop();
  }

  /**
   * Records that a turn started outside the voice loop (a typed Chat Panel turn) so a
   * hotkey press during its playback is Barge-in, and registers its abort handle so
   * that Barge-in can cancel it.
   */
  noteExternalTurnStarted(abort: AbortController): void {
    this.machine.externalTurnStarted();
    this.activeTurnAborts.add(abort);
  }

  /**
   * Records that a turn finished. Only advances the machine when the turn was still
   * active (in the set): a Barge-in already removed it and moved the loop on, so its
   * late completion must not reset the newer interaction.
   */
  noteTurnEnded(abort: AbortController): void {
    if (this.activeTurnAborts.delete(abort)) {
      this.machine.turnEnded();
    }
  }

  /** Handles one recording event from the Pill (live level, finished clip, or capture error). */
  handleRecordEvent(event: VoiceRecordEvent): void {
    // Ignore events from a recording the loop has already moved past (a Barge-in
    // started a newer one, so the old clip/level is noise).
    if (event.turnId !== this.currentRecordingId) {
      return;
    }
    switch (event.type) {
      case "level":
        // Only feed the waveform while actually listening; a level that races past the
        // release must not re-show the waveform after it has ended.
        if (this.machine.phase === "listening") {
          this.dependencies.overlayListenLevel(event.level);
        }
        return;
      case "clip":
        void this.transcribeAndAnswer(event.audioBase64);
        return;
      case "error":
        // The mic could not be captured (denied, no device): end the interaction cleanly
        // rather than hang. A capture error can arrive while still listening (the user is
        // holding the key), so reset from whatever phase - neither a release nor a
        // transcript will come to advance it otherwise.
        console.error("[lune] voice recording failed:", event.reason);
        this.machine.reset();
        this.currentRecordingId = null;
        this.dependencies.overlayListenEnd();
        this.dependencies.setPillActivity("idle");
        return;
    }
  }

  private onHotkeyPressed(): void {
    const plan = this.machine.hotkeyPressed();
    if (plan.bargeIn) {
      // Interrupt every in-flight turn and silence any playback before the new recording,
      // so nothing streams or speaks behind it (no overlap, no zombie audio).
      for (const abort of this.activeTurnAborts) {
        abort.abort();
      }
      this.activeTurnAborts.clear();
      this.dependencies.stopSpeech();
    }
    if (plan.startRecording) {
      this.generation += 1;
      const recordingId = this.dependencies.generateId();
      this.currentRecordingId = recordingId;
      this.dependencies.sendRecordCommand({ type: "start", turnId: recordingId });
      this.dependencies.setPillActivity("listening");
      this.dependencies.overlayListenStart();
    }
  }

  private onHotkeyReleased(): void {
    const plan = this.machine.hotkeyReleased();
    if (plan.stopRecording && this.currentRecordingId !== null) {
      this.dependencies.sendRecordCommand({ type: "stop", turnId: this.currentRecordingId });
      this.dependencies.setPillActivity("thinking");
      this.dependencies.overlayListenEnd();
    }
  }

  /** Transcribes the released clip and, if it carried speech, answers it as a voice turn. */
  private async transcribeAndAnswer(audioBase64: string): Promise<void> {
    const generationAtStart = this.generation;

    if (!this.dependencies.isTranscriptionReady()) {
      // whisper isn't ready (weights still downloading, or the child is down): end the
      // interaction rather than hang. Readiness is surfaced in Settings (ticket 13).
      console.error("[lune] cannot transcribe: whisper is not ready");
      this.finishWithoutTurn(generationAtStart);
      return;
    }

    let transcript: string;
    try {
      transcript = (await this.dependencies.transcribe(this.dependencies.decodeBase64(audioBase64))).trim();
    } catch (error) {
      console.error("[lune] transcription failed:", error);
      this.finishWithoutTurn(generationAtStart);
      return;
    }

    // A Barge-in during transcription bumped the generation: discard this transcript.
    if (this.generation !== generationAtStart) {
      return;
    }

    const { submitTurn } = this.machine.transcribed(transcript.length > 0);
    if (!submitTurn) {
      // Silence (or an empty transcript): back to idle without bothering the Vendor.
      this.dependencies.setPillActivity("idle");
      return;
    }

    const abort = new AbortController();
    this.activeTurnAborts.add(abort);
    const turnId = this.dependencies.generateId();
    try {
      const result = await this.dependencies.runVoiceTurn({ turnId, prompt: transcript, signal: abort.signal });
      // Only settle if this turn is still active (a Barge-in removes it from the set).
      if (this.activeTurnAborts.delete(abort)) {
        this.machine.turnEnded();
        // When the turn spoke, Kokoro playback owns the return to idle; a silent
        // (text-only) turn has no playback, so end the Pill's "thinking" here.
        if (!result.spoke) {
          this.dependencies.setPillActivity("idle");
        }
      }
    } catch (error) {
      // runVoiceTurn surfaces its own errors to the user; this only restores loop state.
      console.error("[lune] voice turn failed:", error);
      if (this.activeTurnAborts.delete(abort)) {
        this.machine.turnEnded();
        this.dependencies.setPillActivity("idle");
      }
    }
  }

  /** Ends a would-be turn that never happened (not ready / failed / empty), if still current. */
  private finishWithoutTurn(generationAtStart: number): void {
    if (this.generation !== generationAtStart) {
      return;
    }
    this.machine.transcribed(false);
    this.currentRecordingId = null;
    this.dependencies.setPillActivity("idle");
  }
}
