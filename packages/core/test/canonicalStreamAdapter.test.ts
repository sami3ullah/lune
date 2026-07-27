import { describe, expect, it } from "vitest";

import { adaptTextDeltasToCanonicalStream } from "../src/reasoning/canonicalStreamAdapter";
import { iterateOpenAiContentDeltas } from "../src/reasoning/sseTextDeltas";
import { identityRemap, remapForScaleFactor } from "../src/reasoning/coordinateRemap";
import type { CoreChatStreamEvent } from "../src/reasoning/chatTypes";

/**
 * Tests for the canonical stream adaptation: given a Vendor's raw answer-text delta
 * stream, the Core emits canonical `text-delta`* + `done` events, repairing and
 * remapping the trailing Point Tag along the way. Carried from v1's `qwenSseAdapter`
 * suite, adapted to assert on canonical events instead of re-serialized SSE bytes.
 * The OpenAI-SSE -> text-delta reduction is fed through `iterateOpenAiContentDeltas`
 * exactly as the OpenAI/Gemini Vendors do in production.
 */

/** Builds a ReadableStream of the given OpenAI SSE text, one chunk per push. */
function openAiSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

/** Builds one OpenAI streaming content-delta SSE line. */
function contentDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** Adapts an OpenAI SSE stream into canonical events, collecting them. */
async function adaptOpenAiStream(
  chunks: string[],
  remap = identityRemap,
): Promise<CoreChatStreamEvent[]> {
  const textDeltas = iterateOpenAiContentDeltas(openAiSseStream(chunks));
  const events: CoreChatStreamEvent[] = [];
  for await (const event of adaptTextDeltasToCanonicalStream(textDeltas, remap)) {
    events.push(event);
  }
  return events;
}

/** The concatenated answer text of the canonical stream. */
function deltaText(events: CoreChatStreamEvent[]): string {
  return events
    .filter((event): event is { type: "text-delta"; text: string } => event.type === "text-delta")
    .map((event) => event.text)
    .join("");
}

describe("adaptTextDeltasToCanonicalStream", () => {
  it("emits text-delta events then exactly one terminal done", async () => {
    const events = await adaptOpenAiStream([
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
      contentDelta("html is the skeleton of a web page."),
      "data: [DONE]\n\n",
    ]);

    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(deltaText(events)).toBe("html is the skeleton of a web page.");
  });

  it("preserves a well-formed tag verbatim so every Vendor is indistinguishable", async () => {
    const events = await adaptOpenAiStream([
      contentDelta("see that source control menu up top? "),
      contentDelta("[POINT:285,11:source control]"),
      "data: [DONE]\n\n",
    ]);
    expect(deltaText(events)).toBe("see that source control menu up top? [POINT:285,11:source control]");
  });

  it("repairs a malformed Point Tag into canonical form", async () => {
    const events = await adaptOpenAiStream([
      contentDelta("you'll want the save button. "),
      contentDelta("[ point : 640 , 360 - Save Button ]"),
      "data: [DONE]\n\n",
    ]);
    expect(deltaText(events)).toBe("you'll want the save button. [POINT:640,360:Save Button]");
  });

  it("remaps downscaled-space coordinates back to real screen space, incl. multi-screen", async () => {
    const events = await adaptOpenAiStream(
      [
        contentDelta("that's over on your other monitor. "),
        contentDelta("[POINT:200,150:terminal:screen2]"),
        "data: [DONE]\n\n",
      ],
      remapForScaleFactor(0.5),
    );
    expect(deltaText(events)).toBe(
      "that's over on your other monitor. [POINT:400,300:terminal:screen2]",
    );
  });

  it("repairs a tag split across many small deltas", async () => {
    const events = await adaptOpenAiStream(
      [
        contentDelta("here "),
        contentDelta("[POINT:"),
        contentDelta("100,"),
        contentDelta("200:"),
        contentDelta("menu]"),
        "data: [DONE]\n\n",
      ],
      remapForScaleFactor(0.5),
    );
    expect(deltaText(events)).toBe("here [POINT:200,400:menu]");
  });

  it("passes through a [POINT:none] answer", async () => {
    const events = await adaptOpenAiStream([
      contentDelta("html stands for hypertext markup language. "),
      contentDelta("[POINT:none]"),
      "data: [DONE]\n\n",
    ]);
    expect(deltaText(events)).toBe("html stands for hypertext markup language. [POINT:none]");
  });

  it("repairs and remaps a teaching turn's trailing shape tags, including multi-screen", async () => {
    // A teaching turn appends drawing tags after the prose; they are held back until
    // complete, then repaired and remapped just like a Point Tag.
    const events = await adaptOpenAiStream(
      [
        contentDelta("this box feeds into that one. "),
        contentDelta("[ rect : 10,20,110,120 : the input : dotted ]"),
        contentDelta(" [ARROW:110,120,300,320:it flows here:screen2]"),
        "data: [DONE]\n\n",
      ],
      remapForScaleFactor(0.5),
    );
    expect(deltaText(events)).toBe(
      "this box feeds into that one. [RECT:20,40,220,240:the input:dotted] [ARROW:220,240,600,640:it flows here:screen2]",
    );
  });
});
