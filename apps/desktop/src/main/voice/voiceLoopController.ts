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
  /**
   * Gives the user a friendly "I didn't catch that" when a hold produced no discernible
   * speech (near-silence), instead of transcribing a whisper hallucination and answering
   * it. Speaks the nudge when Kokoro is ready; returns whether it spoke so the caller
   * knows who returns the Pill to idle (like a real turn).
   */
  announceNoSpeech: () => Promise<VoiceTurnResult>;
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
  /**
   * While a Screen Agent Confirm Gate is open, the spoken answer is routed here instead of
   * being run as a turn (M2-04). When set, the push-to-talk key answers the gate - hold to
   * speak "yes"/"no" - and never barges in the run the gate guards. Cleared when the gate
   * closes.
   */
  private gateAnswer: ((transcript: string) => void) | null = null;
  /** The id of the in-flight gate-answer recording, distinct from a turn recording. */
  private gateRecordingId: string | null = null;

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

  /**
   * Opens Confirm Gate voice capture (M2-04): while this is active, the push-to-talk key
   * answers the open gate - hold to speak, release to transcribe - and the recognized text
   * is handed to `deliver` (which the gate classifies into yes/no/unclear) instead of being
   * run as a conversation turn. Crucially, a press does NOT barge-in the Screen Agent run
   * the gate guards, so the user can answer by voice without cancelling the run. Returns a
   * disposer that closes capture and stops any in-flight gate recording; call it when the
   * gate resolves.
   */
  openConfirmGateCapture(deliver: (transcript: string) => void): () => void {
    this.gateAnswer = deliver;
    return () => {
      if (this.gateAnswer !== deliver) {
        return;
      }
      this.gateAnswer = null;
      if (this.gateRecordingId !== null) {
        this.dependencies.sendRecordCommand({ type: "stop", turnId: this.gateRecordingId });
        this.dependencies.overlayListenEnd();
        this.gateRecordingId = null;
      }
    };
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
        // release must not re-show the waveform after it has ended. A gate-answer recording
        // is a second "listening" state the turn machine doesn't model, so show it too.
        if (this.machine.phase === "listening" || this.gateRecordingId !== null) {
          this.dependencies.overlayListenLevel(event.level);
        }
        return;
      case "clip":
        // A gate-answer clip goes to the open Confirm Gate; any other clip is a turn.
        if (this.gateRecordingId !== null && event.turnId === this.gateRecordingId) {
          void this.transcribeForGate(event.audioBase64);
        } else {
          void this.transcribeAndAnswer(event.audioBase64);
        }
        return;
      case "silent":
        // A silent gate-answer hold is an unclear reply: hand the gate an empty transcript,
        // which it treats as ambiguous and re-prompts (never a proceed).
        if (this.gateRecordingId !== null && event.turnId === this.gateRecordingId) {
          this.gateRecordingId = null;
          this.dependencies.overlayListenEnd();
          this.gateAnswer?.("");
          return;
        }
        // The hold held no discernible speech: nudge the user instead of transcribing a
        // hallucination. Settle the machine as a no-speech turn, then announce.
        this.machine.transcribed(false);
        this.currentRecordingId = null;
        this.dependencies.overlayListenEnd();
        void this.announceNoSpeech();
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
    // A Confirm Gate is open: the key answers it (hold to speak) rather than running a turn
    // or barging in the run it guards. Bypasses the turn machine entirely so no in-flight
    // Screen Agent run is aborted while the user is deciding.
    if (this.gateAnswer !== null) {
      this.startGateAnswerRecording();
      return;
    }

    const plan = this.machine.hotkeyPressed();
    if (plan.bargeIn) {
      // A turn is still streaming/answering: abort it so nothing streams behind the new
      // recording (no overlap, no zombie stream).
      for (const abort of this.activeTurnAborts) {
        abort.abort();
      }
      this.activeTurnAborts.clear();
    }
    if (plan.startRecording) {
      // Silence any speech before listening, unconditionally. Barge-in aborts an in-flight
      // turn above, but audio can still be playing even after the machine has returned to
      // idle: synthesis finishing ends the turn (phase -> idle) while Kokoro keeps playing
      // the tail in the renderer. A press in that window is a plain idle->listening start
      // (bargeIn:false) yet the user still hears Lune, so gating stopSpeech on bargeIn let
      // the old answer talk over the new phrase. Stopping here - a no-op when nothing is
      // playing - guarantees a press always cuts playback and just listens.
      this.dependencies.stopSpeech();
      this.generation += 1;
      const recordingId = this.dependencies.generateId();
      this.currentRecordingId = recordingId;
      this.dependencies.sendRecordCommand({ type: "start", turnId: recordingId });
      this.dependencies.setPillActivity("listening");
      this.dependencies.overlayListenStart();
    }
  }

  private onHotkeyReleased(): void {
    // Releasing a gate-answer hold stops that recording; the clip transcribes to the gate.
    // The turn machine never saw the press, so it must not see this release either.
    if (this.gateRecordingId !== null) {
      this.dependencies.sendRecordCommand({ type: "stop", turnId: this.gateRecordingId });
      this.dependencies.overlayListenEnd();
      return;
    }

    const plan = this.machine.hotkeyReleased();
    if (plan.stopRecording && this.currentRecordingId !== null) {
      this.dependencies.sendRecordCommand({ type: "stop", turnId: this.currentRecordingId });
      this.dependencies.setPillActivity("thinking");
      this.dependencies.overlayListenEnd();
    }
  }

  /** Starts a gate-answer recording (Confirm Gate voice capture), separate from a turn recording. */
  private startGateAnswerRecording(): void {
    // Bump the generation so any in-flight turn transcription is discarded (as a barge-in
    // would), then record through the Pill on a distinct id the clip handler routes to the gate.
    this.generation += 1;
    const recordingId = this.dependencies.generateId();
    this.gateRecordingId = recordingId;
    this.currentRecordingId = recordingId;
    this.dependencies.sendRecordCommand({ type: "start", turnId: recordingId });
    this.dependencies.overlayListenStart();
  }

  /** Transcribes a released gate-answer clip and hands the text to the open gate. */
  private async transcribeForGate(audioBase64: string): Promise<void> {
    const deliver = this.gateAnswer;
    this.gateRecordingId = null;
    this.dependencies.overlayListenEnd();
    if (deliver === null) {
      return;
    }
    if (!this.dependencies.isTranscriptionReady()) {
      // whisper isn't ready: treat as an unclear reply so the gate re-prompts, never proceeds.
      deliver("");
      return;
    }
    try {
      const transcript = (
        await this.dependencies.transcribe(this.dependencies.decodeBase64(audioBase64))
      ).trim();
      // Only answer if the same gate is still open (it may have been resolved by the chip or
      // hotkey, or closed, while transcription ran).
      if (this.gateAnswer === deliver) {
        deliver(transcript);
      }
    } catch (error) {
      console.error("[lune] gate-answer transcription failed:", error);
      if (this.gateAnswer === deliver) {
        deliver("");
      }
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

  /** Speaks the friendly "didn't catch that" nudge for a silent hold, then settles idle. */
  private async announceNoSpeech(): Promise<void> {
    const generationAtStart = this.generation;
    try {
      const result = await this.dependencies.announceNoSpeech();
      // If a Barge-in moved on, or the nudge spoke (Kokoro playback owns the return to
      // idle), don't touch the Pill; otherwise settle it here.
      if (this.generation === generationAtStart && !result.spoke) {
        this.dependencies.setPillActivity("idle");
      }
    } catch (error) {
      console.error("[lune] no-speech nudge failed:", error);
      if (this.generation === generationAtStart) {
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
