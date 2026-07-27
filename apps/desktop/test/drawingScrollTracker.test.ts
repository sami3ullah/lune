import { describe, expect, it } from "vitest";
import { DrawingScrollTracker } from "../src/main/overlay/drawingScrollTracker";

// The stale-drawing policy: a teaching drawing is anchored to the screenshot it was
// placed against, so scrolling must clear a visible drawing at once and suppress a
// drawing whose turn captured the screen before the scroll.

describe("DrawingScrollTracker", () => {
  it("asks to clear exactly once when scrolling while a drawing is up", () => {
    const tracker = new DrawingScrollTracker();
    tracker.noteDrawingShown();

    expect(tracker.noteScroll()).toBe(true);
    // Further scroll ticks of the same gesture don't spam more clears.
    expect(tracker.noteScroll()).toBe(false);
    expect(tracker.noteScroll()).toBe(false);
  });

  it("never asks to clear when nothing is drawn", () => {
    const tracker = new DrawingScrollTracker();
    expect(tracker.noteScroll()).toBe(false);
  });

  it("asks to clear again for a fresh drawing after a scroll", () => {
    const tracker = new DrawingScrollTracker();
    tracker.noteDrawingShown();
    expect(tracker.noteScroll()).toBe(true);

    tracker.noteDrawingShown();
    expect(tracker.noteScroll()).toBe(true);
  });

  it("does not ask to clear after the drawing was cleared by another path", () => {
    const tracker = new DrawingScrollTracker();
    tracker.noteDrawingShown();
    tracker.noteDrawingCleared();

    expect(tracker.noteScroll()).toBe(false);
  });

  it("marks a capture stale only when a scroll happened after it", () => {
    const tracker = new DrawingScrollTracker();
    const atCapture = tracker.generation();
    expect(tracker.isStaleSince(atCapture)).toBe(false);

    tracker.noteScroll();
    expect(tracker.isStaleSince(atCapture)).toBe(true);
    // A fresh capture taken after the scroll is current again.
    expect(tracker.isStaleSince(tracker.generation())).toBe(false);
  });
});
