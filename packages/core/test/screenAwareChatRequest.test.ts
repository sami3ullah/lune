import { describe, expect, it } from "vitest";
import { screenAwareChatRequest, type ScreenCaptureInput } from "../src/reasoning/chatTypes.js";
import { extractScreenshots, prepareMessages } from "../src/reasoning/messagePreparation.js";

// The screen-aware request builder is what the Electron main process hands the
// Reasoning Capability once screen capture lands: the user's typed (or spoken) turn
// carries the labeled screenshots of every connected display alongside the prompt.
// These tests pin the block structure the downscale-aware pipeline
// (`messagePreparation`) then consumes, so a drift on either side fails here.

const CURSOR_SCREEN: ScreenCaptureInput = {
  base64Data: "cursor-screen-bytes",
  mediaType: "image/jpeg",
  widthInPixels: 1280,
  heightInPixels: 800,
  label: "screen 1 of 2 - cursor is on this screen (primary focus)",
};

const SECONDARY_SCREEN: ScreenCaptureInput = {
  base64Data: "secondary-screen-bytes",
  mediaType: "image/jpeg",
  widthInPixels: 1440,
  heightInPixels: 900,
  label: "screen 2 of 2 - secondary screen",
};

describe("screenAwareChatRequest", () => {
  it("builds one user turn whose blocks pair each screenshot with a dimensioned label, prompt last", () => {
    const request = screenAwareChatRequest("what's on my screen?", [CURSOR_SCREEN, SECONDARY_SCREEN]);

    expect(request.messages).toHaveLength(1);
    const turn = request.messages[0]!;
    expect(turn.role).toBe("user");
    expect(Array.isArray(turn.content)).toBe(true);
    const blocks = turn.content as Array<{ type: string }>;

    // image, label, image, label, prompt - each screenshot immediately followed by
    // its own text label so the model reads the two together, and the prompt closes.
    expect(blocks.map((block) => block.type)).toEqual(["image", "text", "image", "text", "text"]);
  });

  it("embeds each screenshot's captured pixel dimensions into its label in the rewritable 'WxH pixels' form", () => {
    const request = screenAwareChatRequest("describe this", [CURSOR_SCREEN]);
    const blocks = request.messages[0]!.content as Array<{ type: string; text?: string }>;
    const labelBlock = blocks[1]!;

    expect(labelBlock.type).toBe("text");
    expect(labelBlock.text).toContain("cursor is on this screen (primary focus)");
    // The exact "1280x800 pixels" substring is what the pipeline's downscale rewrite
    // matches; the label must state the captured dimensions so a downscale can shrink
    // them to what the model actually receives.
    expect(labelBlock.text).toContain("1280x800 pixels");
  });

  it("carries the prompt verbatim as the final text block", () => {
    const request = screenAwareChatRequest("point at the save button", [CURSOR_SCREEN]);
    const blocks = request.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks.at(-1)).toEqual({ type: "text", text: "point at the save button" });
  });

  it("degrades to a plain text turn when no screens were captured", () => {
    const request = screenAwareChatRequest("just a question", []);
    expect(request.messages).toEqual([{ role: "user", content: "just a question" }]);
  });

  it("produces screenshots the pipeline extracts in display order", () => {
    const request = screenAwareChatRequest("q", [CURSOR_SCREEN, SECONDARY_SCREEN]);
    expect(extractScreenshots(request)).toEqual([
      { base64Data: "cursor-screen-bytes", mediaType: "image/jpeg" },
      { base64Data: "secondary-screen-bytes", mediaType: "image/jpeg" },
    ]);
  });

  it("has its stated dimensions rewritten to the downscaled size the model sees", () => {
    const request = screenAwareChatRequest("q", [CURSOR_SCREEN]);
    const prepared = prepareMessages({
      request,
      downscaledScreenshots: [
        { base64Data: "smaller", mediaType: "image/jpeg", scaleFactor: 0.5 },
      ],
    });
    const blocks = prepared[0]!.content as Array<{ kind: string; text?: string; base64Data?: string }>;
    // The downscaled bytes are substituted for the image block...
    expect(blocks[0]).toMatchObject({ kind: "image", base64Data: "smaller" });
    // ...and the label's dimensions are halved to match (1280x800 -> 640x400).
    expect(blocks[1]!.text).toContain("640x400 pixels");
    expect(blocks[1]!.text).not.toContain("1280x800");
  });
});
