import { describe, expect, it } from "vitest";
import { buildConversationRequest } from "../src/conversation/buildConversationRequest.js";
import { CANONICAL_SYSTEM_PROMPT } from "../src/reasoning/canonicalSystemPrompt.js";
import type { ConversationMessage } from "../src/conversation/conversationTypes.js";
import type { ScreenCaptureInput } from "../src/reasoning/chatTypes.js";

const SCREEN: ScreenCaptureInput = {
  base64Data: "screen-bytes",
  mediaType: "image/jpeg",
  widthInPixels: 1280,
  heightInPixels: 800,
  label: "user's screen (cursor is here)",
};

const HISTORY: ConversationMessage[] = [
  { id: "u1", role: "user", inputMethod: "text", text: "what is this file?" },
  { id: "a1", role: "assistant", text: "it's a config file." },
];

describe("buildConversationRequest", () => {
  it("renders prior turns as alternating plain-text history and the current turn last", () => {
    const request = buildConversationRequest(
      [...HISTORY, { id: "u2", role: "user", inputMethod: "text", text: "and now?" }],
      [],
    );

    expect(request.messages).toHaveLength(3);
    expect(request.messages.slice(0, 2)).toEqual([
      { role: "user", content: "what is this file?" },
      { role: "assistant", content: "it's a config file." },
    ]);
    // The current turn is last and, with no screenshots, is plain text too.
    expect(request.messages[2]).toEqual({ role: "user", content: "and now?" });
  });

  it("carries only the current turn's screenshots, never the history's", () => {
    const request = buildConversationRequest(
      [...HISTORY, { id: "u2", role: "user", inputMethod: "text", text: "what's on my screen?" }],
      [SCREEN],
    );

    // History stays plain text (no image blocks)...
    expect(request.messages[0]).toEqual({ role: "user", content: "what is this file?" });
    // ...and the current turn carries the screenshot as blocks (image, label, prompt).
    const currentContent = request.messages[2]!.content as Array<{ type: string }>;
    expect(currentContent.map((block) => block.type)).toEqual(["image", "text", "text"]);
  });

  it("returns an empty request when there are no messages", () => {
    expect(buildConversationRequest([], [])).toEqual({ messages: [] });
  });

  it("leaves the system prompt to the Vendor default when no suffix is given (M4-01)", () => {
    const request = buildConversationRequest(
      [{ id: "u1", role: "user", inputMethod: "text", text: "hi" }],
      [],
    );
    // No `system`: each Vendor falls back to CANONICAL_SYSTEM_PROMPT itself.
    expect(request.system).toBeUndefined();
  });

  it("appends a non-blank system suffix to the canonical prompt, never overwriting it (M4-01)", () => {
    const suffix = "=== active skills ===\nalways answer in one short sentence.";
    const request = buildConversationRequest(
      [{ id: "u1", role: "user", inputMethod: "text", text: "hi" }],
      [],
      suffix,
    );
    // The whole persona/grammar prompt leads; the Skills suffix is appended after it.
    expect(request.system).toBe(`${CANONICAL_SYSTEM_PROMPT}\n\n${suffix}`);
  });

  it("ignores a blank suffix (whitespace only) so it never dilutes the prompt (M4-01)", () => {
    const request = buildConversationRequest(
      [{ id: "u1", role: "user", inputMethod: "text", text: "hi" }],
      [],
      "   \n  ",
    );
    expect(request.system).toBeUndefined();
  });
});
