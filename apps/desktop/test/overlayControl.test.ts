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

  it("rejects an unknown event type", () => {
    expect(OverlayEventSchema.safeParse({ type: "explode" }).success).toBe(false);
  });
});
