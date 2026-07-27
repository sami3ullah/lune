import { describe, expect, it } from "vitest";
import { OverlayEventSchema } from "../src/ipc/overlayControl";

// The overlay-control IPC codec is the Shell's boundary guard for the click-through
// cursor overlay: the main process validates each event on the way out and the
// renderer on the way in, so no untyped shape ever drives the cursor.
describe("OverlayEventSchema", () => {
  it("accepts each event in the interaction lifecycle", () => {
    expect(OverlayEventSchema.parse({ type: "activity-start" }).type).toBe("activity-start");
    expect(OverlayEventSchema.parse({ type: "answer-delta", text: "hi" })).toEqual({
      type: "answer-delta",
      text: "hi",
    });
    expect(
      OverlayEventSchema.parse({
        type: "point",
        point: { localX: 12, localY: 34, label: "Save" },
      }),
    ).toEqual({ type: "point", point: { localX: 12, localY: 34, label: "Save" } });
    expect(OverlayEventSchema.parse({ type: "activity-end" }).type).toBe("activity-end");
  });

  it("accepts a word-by-word caption (and an empty word list to clear it)", () => {
    expect(
      OverlayEventSchema.parse({ type: "caption", id: "caption-1", words: ["Here", "you"] }),
    ).toEqual({ type: "caption", id: "caption-1", words: ["Here", "you"] });
    expect(
      OverlayEventSchema.safeParse({ type: "caption", id: "", words: [] }).success,
    ).toBe(true);
    expect(OverlayEventSchema.safeParse({ type: "caption", id: "caption-1" }).success).toBe(false);
    expect(OverlayEventSchema.safeParse({ type: "caption", words: ["hi"] }).success).toBe(false);
  });

  it("accepts the listening + thinking events", () => {
    expect(OverlayEventSchema.parse({ type: "listen-start" }).type).toBe("listen-start");
    expect(OverlayEventSchema.parse({ type: "listen-level", level: 0.5 }).type).toBe("listen-level");
    expect(OverlayEventSchema.parse({ type: "listen-end" }).type).toBe("listen-end");
    expect(OverlayEventSchema.parse({ type: "thinking-start" }).type).toBe("thinking-start");
    expect(OverlayEventSchema.parse({ type: "thinking-end" }).type).toBe("thinking-end");
  });

  it("accepts the cursor-follow events", () => {
    expect(
      OverlayEventSchema.parse({ type: "cursor-move", position: { localX: 12, localY: 34 } }),
    ).toEqual({ type: "cursor-move", position: { localX: 12, localY: 34 } });
    expect(OverlayEventSchema.parse({ type: "cursor-leave" }).type).toBe("cursor-leave");
  });

  it("rejects a cursor-move missing its position", () => {
    expect(OverlayEventSchema.safeParse({ type: "cursor-move" }).success).toBe(false);
    expect(
      OverlayEventSchema.safeParse({ type: "cursor-move", position: { localX: 1 } }).success,
    ).toBe(false);
  });

  it("allows an empty answer delta but requires the field to be a string", () => {
    expect(OverlayEventSchema.safeParse({ type: "answer-delta", text: "" }).success).toBe(true);
    expect(OverlayEventSchema.safeParse({ type: "answer-delta" }).success).toBe(false);
    expect(OverlayEventSchema.safeParse({ type: "answer-delta", text: 5 }).success).toBe(false);
  });

  it("rejects a point missing its coordinates", () => {
    expect(
      OverlayEventSchema.safeParse({ type: "point", point: { localX: 1, label: "x" } }).success,
    ).toBe(false);
  });

  it("accepts the intro-video events (a wizard rect to avoid, or null when off-display)", () => {
    expect(
      OverlayEventSchema.parse({
        type: "intro-video-start",
        avoidRect: { x: 440, y: 130, width: 560, height: 640 },
      }),
    ).toEqual({ type: "intro-video-start", avoidRect: { x: 440, y: 130, width: 560, height: 640 } });
    expect(
      OverlayEventSchema.parse({ type: "intro-video-start", avoidRect: null }),
    ).toEqual({ type: "intro-video-start", avoidRect: null });
    expect(OverlayEventSchema.parse({ type: "intro-video-end" }).type).toBe("intro-video-end");
    // The avoidRect is required (nullable, not optional), so an incomplete rect is rejected.
    expect(OverlayEventSchema.safeParse({ type: "intro-video-start" }).success).toBe(false);
    expect(
      OverlayEventSchema.safeParse({ type: "intro-video-start", avoidRect: { x: 1, y: 2 } }).success,
    ).toBe(false);
  });

  it("rejects an unknown event type", () => {
    expect(OverlayEventSchema.safeParse({ type: "explode" }).success).toBe(false);
  });
});
