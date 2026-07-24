// The shape of Lune's spoken caption as it reveals word by word (issue: book-style
// caption). Both the Pill and the Overlay render the same reveal from this data - the
// Pill owns Kokoro playback timing and drives it, mirroring the words onto the Overlay
// over IPC so the two surfaces stay in lockstep with the voice.

export interface CaptionData {
  /**
   * Identity of the sentence being spoken. It changes per sentence, so the reveal
   * component can key off it to restart cleanly (reset its line, re-run the animation)
   * when a new sentence begins.
   */
  id: string;
  /** The words of the current sentence revealed so far, in spoken order. */
  words: string[];
}
