// Keeps teaching drawings honest about scrolling (the stale-drawing fix). A drawing's
// coordinates come from the screenshot captured at the start of its turn, so they are
// only meaningful while the content under them hasn't moved. Scrolling breaks that in
// two ways, and this tracker covers both:
//
//   - scroll while a drawing is up: the marks now ring the wrong pixels, so the drawing
//     must clear immediately (`noteScroll` returns true and the caller broadcasts
//     `clear-shapes`);
//   - scroll between a turn's capture and its answer: the shapes the model is about to
//     draw were placed against a screen that no longer exists, so the turn suppresses
//     them (`isStaleSince` against the generation snapshotted at capture time).
//
// It is a pure decision (a generation counter + a visible flag) so the policy is unit-
// testable; the main process wires it to the shared global input hook's wheel events and
// to the shape planner. The visible flag is a main-process view of the renderer's
// lifecycle: the renderer may also clear a drawing on its own quiet-timeout, in which
// case the next scroll broadcasts one redundant (harmless) clear.
export class DrawingScrollTracker {
  private scrollGeneration = 0;
  private drawingVisible = false;

  /**
   * Records one global scroll tick. Returns `true` exactly when a drawing is up and must
   * now be cleared - once per drawing, so a long scroll doesn't spam clear broadcasts.
   */
  noteScroll(): boolean {
    this.scrollGeneration += 1;
    if (this.drawingVisible) {
      this.drawingVisible = false;
      return true;
    }
    return false;
  }

  /** The current scroll generation; snapshot this right after a turn's screen capture. */
  generation(): number {
    return this.scrollGeneration;
  }

  /** Whether the screen has scrolled since the given capture-time generation snapshot. */
  isStaleSince(generationAtCapture: number): boolean {
    return this.scrollGeneration !== generationAtCapture;
  }

  /** Records that a drawing is now showing (shape messages were sent to the Overlay). */
  noteDrawingShown(): void {
    this.drawingVisible = true;
  }

  /** Records that the drawing was cleared by some other path (next turn, barge-in). */
  noteDrawingCleared(): void {
    this.drawingVisible = false;
  }
}
