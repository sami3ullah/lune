import { describe, expect, it } from "vitest";

import { SpeechSentenceChunker } from "../src/main/speech/sentenceChunker";

/**
 * Unit tests for the sentence chunker (ticket 09), the pure Shell logic that turns
 * the growing Reasoning stream into complete sentences for sentence-streamed Kokoro
 * playback. Ported from v1's `SpeechSentenceChunker.swift` behaviour: each sentence
 * emitted exactly once, decimals not split, and the trailing `[POINT:...]` tag held
 * back and dropped from speech.
 */

describe("SpeechSentenceChunker.ingest", () => {
  it("emits each complete sentence exactly once as the text grows", () => {
    const chunker = new SpeechSentenceChunker();
    // First snapshot: one complete sentence plus an in-progress second.
    expect(chunker.ingest("Hello there. How are")).toEqual(["Hello there."]);
    // The already-emitted first sentence is never repeated.
    expect(chunker.ingest("Hello there. How are you? I am")).toEqual(["How are you?"]);
    // The final sentence completes (ends the text) and is emitted exactly once.
    expect(chunker.ingest("Hello there. How are you? I am fine!")).toEqual(["I am fine!"]);
    expect(chunker.ingest("Hello there. How are you? I am fine!")).toEqual([]);
  });

  it("emits multiple sentences that completed in one snapshot", () => {
    const chunker = new SpeechSentenceChunker();
    expect(chunker.ingest("One. Two! Three? Four")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("does not split on a decimal point between digits", () => {
    const chunker = new SpeechSentenceChunker();
    // "3.14" must stay intact; only the real sentence end after "pie." completes.
    expect(chunker.ingest("Pi is 3.14 and I like pie. Yum")).toEqual([
      "Pi is 3.14 and I like pie.",
    ]);
  });

  it("does not treat punctuation mid-word as a sentence end", () => {
    const chunker = new SpeechSentenceChunker();
    // The "." in a filename is not followed by whitespace, so it is not a boundary.
    expect(chunker.ingest("Open config.json now")).toEqual([]);
  });

  it("absorbs trailing quotes and brackets into the sentence", () => {
    const chunker = new SpeechSentenceChunker();
    expect(chunker.ingest('She said "hello." Then')).toEqual(['She said "hello."']);
  });

  it("never speaks text from the trailing point tag onward", () => {
    const chunker = new SpeechSentenceChunker();
    // The "[" opens the (possibly incomplete) point tag; nothing from it is spoken,
    // and the sentence before it is only emitted once the tag confirms the boundary.
    expect(chunker.ingest("Click the save button. [POINT:100,200:save button:screen1]")).toEqual([
      "Click the save button.",
    ]);
  });

  it("holds back a completed sentence while the point tag is still streaming in", () => {
    const chunker = new SpeechSentenceChunker();
    // The bracket has appeared but the tag is incomplete; the sentence is already done.
    expect(chunker.ingest("There it is. [POIN")).toEqual(["There it is."]);
    // No new speakable text arrives as the tag finishes.
    expect(chunker.ingest("There it is. [POINT:1,2:it:screen1]")).toEqual([]);
  });
});

describe("SpeechSentenceChunker.flushRemaining", () => {
  it("returns the final unterminated sentence and drops the point tag", () => {
    const chunker = new SpeechSentenceChunker();
    chunker.ingest("First sentence. See that button");
    expect(chunker.flushRemaining("First sentence. See that button [POINT:5,5:button:screen1]")).toBe(
      "See that button",
    );
  });

  it("returns undefined when nothing speakable remains after the last sentence", () => {
    const chunker = new SpeechSentenceChunker();
    chunker.ingest("All done here.");
    expect(chunker.flushRemaining("All done here.")).toBeUndefined();
  });

  it("returns undefined when only the point tag remains", () => {
    const chunker = new SpeechSentenceChunker();
    chunker.ingest("Look here. ");
    expect(chunker.flushRemaining("Look here. [POINT:1,1:here:screen1]")).toBeUndefined();
  });
});
