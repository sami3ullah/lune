// The pure push-to-talk voice-loop state machine (ticket 11): the phase transitions of
// one hold-speak-release interaction, and - the load-bearing part - the Barge-in
// decision. It owns no timers, audio, or IPC; the main-process wiring drives it with
// hotkey/transcription/turn events and acts on the plans it returns. Keeping the
// decision here (pure, tested) is why Barge-in - "no overlap, no zombie audio" - can be
// verified without spinning up a mic, a Vendor stream, and a speaker.
//
// The interaction moves idle -> listening (hold) -> transcribing (release) -> answering
// (a non-empty transcript became a turn) -> idle (the turn finished). A hotkey press
// while anything is already happening (transcribing or answering) is Barge-in: the
// wiring aborts the in-flight turn and stops speech, and a fresh recording starts at
// once. A turn started from elsewhere (a typed Chat Panel turn that speaks) also enters
// "answering", so pressing the hotkey during its playback interrupts it the same way.

/** Where one push-to-talk interaction is in its lifecycle. */
export type VoicePhase = "idle" | "listening" | "transcribing" | "answering";

/** What the wiring should do in response to a hotkey press (the hold beginning). */
export interface HotkeyPressPlan {
  /** Start capturing the microphone now (always true unless already listening). */
  startRecording: boolean;
  /**
   * This press interrupted work in flight (Barge-in): the wiring must abort the
   * in-flight Reasoning turn (its AbortSignal) and stop any speech playback before the
   * new recording's answer begins - so the old answer never overlaps the new turn.
   */
  bargeIn: boolean;
}

export class VoiceLoopMachine {
  private currentPhase: VoicePhase = "idle";

  /** The interaction's current phase (drives the Pill/Overlay state the wiring shows). */
  get phase(): VoicePhase {
    return this.currentPhase;
  }

  /**
   * The push-to-talk hotkey went down (the user began holding it). From idle this
   * simply starts recording; while a transcription or answer is in flight it is
   * Barge-in - interrupt and start a fresh recording. A press while already listening
   * (no intervening release) is a no-op, since one hold cannot re-press itself.
   */
  hotkeyPressed(): HotkeyPressPlan {
    switch (this.currentPhase) {
      case "idle":
        this.currentPhase = "listening";
        return { startRecording: true, bargeIn: false };
      case "listening":
        return { startRecording: false, bargeIn: false };
      case "transcribing":
      case "answering":
        this.currentPhase = "listening";
        return { startRecording: true, bargeIn: true };
    }
  }

  /**
   * The hotkey was released (the hold ended). Only a release that ends the listening
   * phase finalizes the recording for transcription; a release in any other phase (e.g.
   * the modifier lifted after a Barge-in already restarted) is ignored.
   */
  hotkeyReleased(): { stopRecording: boolean } {
    if (this.currentPhase === "listening") {
      this.currentPhase = "transcribing";
      return { stopRecording: true };
    }
    return { stopRecording: false };
  }

  /**
   * The released clip came back from whisper. A transcript with speech becomes a turn
   * (enter answering); an empty transcript (silence, or the clip was too short) returns
   * to idle without bothering the Vendor. A result arriving after a Barge-in already
   * moved the loop on is ignored (the wiring also guards this by generation).
   */
  transcribed(hasSpeech: boolean): { submitTurn: boolean } {
    if (this.currentPhase !== "transcribing") {
      return { submitTurn: false };
    }
    this.currentPhase = hasSpeech ? "answering" : "idle";
    return { submitTurn: hasSpeech };
  }

  /**
   * A turn started from outside the voice loop (a typed Chat Panel turn) began
   * answering, so the loop should treat it as interruptible: a hotkey press during its
   * playback is Barge-in. Only meaningful from idle - the voice flow already manages
   * its own transition into answering via {@link transcribed}.
   */
  externalTurnStarted(): void {
    if (this.currentPhase === "idle") {
      this.currentPhase = "answering";
    }
  }

  /**
   * The answering turn finished (completed or errored). Returns to idle so the next
   * hotkey press starts a clean interaction. Ignored in any other phase, so a late
   * completion from a turn that Barge-in already superseded cannot reset a newer
   * interaction (the wiring additionally guards this by turn generation).
   */
  turnEnded(): void {
    if (this.currentPhase === "answering") {
      this.currentPhase = "idle";
    }
  }

  /**
   * Forces the interaction back to idle from any phase. Used when the interaction
   * cannot continue from where it is - e.g. the mic could not be captured while still
   * listening, so neither a release nor a transcript will ever arrive to advance it.
   */
  reset(): void {
    this.currentPhase = "idle";
  }
}
