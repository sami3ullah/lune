// A subtle, elegant completion chime for the Agent Stack: one soft two-note bell played when a
// background task finishes, quiet enough not to interrupt whatever the user is doing. It's Web
// Audio only - nothing to bundle - and the AudioContext is created lazily on the first real
// completion, so a normal session that never runs a task spins up no audio graph at all.

let audioContext: AudioContext | null = null;

/** The shared AudioContext, created on first use; `null` when Web Audio isn't available. */
function context(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) {
    return null;
  }
  if (audioContext === null) {
    audioContext = new Ctor();
  }
  return audioContext;
}

/**
 * Plays one soft bell note: a sine fundamental plus a quieter octave partial for a warm
 * timbre, under a gentle attack and a long exponential decay so it rings rather than beeps.
 */
function playBell(ctx: AudioContext, frequency: number, startTime: number, peakGain: number): void {
  const envelope = ctx.createGain();
  envelope.connect(ctx.destination);
  envelope.gain.setValueAtTime(0.0001, startTime);
  envelope.gain.linearRampToValueAtTime(peakGain, startTime + 0.015);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.9);

  for (const [ratio, level] of [
    [1, 1],
    [2, 0.35],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency * ratio;
    const partial = ctx.createGain();
    partial.gain.value = level;
    osc.connect(partial).connect(envelope);
    osc.start(startTime);
    osc.stop(startTime + 0.95);
  }
}

/**
 * Plays the elegant two-note completion chime once - a soft rising fourth (B5 -> E6). Safe to
 * call anytime; a no-op when Web Audio is unavailable, and a blocked context (no user gesture
 * yet) just drops the chime rather than surfacing an error - a missed ding isn't worth one.
 */
export function playCompletionChime(): void {
  const ctx = context();
  if (ctx === null) {
    return;
  }
  const ready = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
  void ready
    .then(() => {
      const now = ctx.currentTime;
      playBell(ctx, 987.77, now, 0.06); // B5
      playBell(ctx, 1318.51, now + 0.13, 0.05); // E6
    })
    .catch(() => {
      /* audio blocked; a missed chime is not worth surfacing */
    });
}
