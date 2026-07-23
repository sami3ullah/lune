import { describe, expect, it } from "vitest";
import { PillContentSizeSchema } from "../src/ipc/pillControl";

// The pill-control IPC codec is the Shell's own boundary guard: main resizes its
// frameless window to whatever the renderer reports, so a bad size must be rejected
// at the seam rather than shrinking the window to nothing.
describe("PillContentSizeSchema", () => {
  it("accepts a positive content size", () => {
    expect(PillContentSizeSchema.parse({ width: 240, height: 260 })).toEqual({
      width: 240,
      height: 260,
    });
  });

  it("rejects zero, negative, or missing dimensions", () => {
    expect(PillContentSizeSchema.safeParse({ width: 0, height: 260 }).success).toBe(false);
    expect(PillContentSizeSchema.safeParse({ width: 240, height: -10 }).success).toBe(false);
    expect(PillContentSizeSchema.safeParse({ width: 240 }).success).toBe(false);
  });
});
