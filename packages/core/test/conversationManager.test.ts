import { describe, expect, it } from "vitest";
import { createConversationManager } from "../src/conversation/conversationManager.js";
import { CANONICAL_SYSTEM_PROMPT } from "../src/reasoning/canonicalSystemPrompt.js";
import type { ReasoningCapability } from "../src/reasoning/reasoningCapability.js";
import type { CoreChatRequest, CoreChatStreamEvent } from "../src/reasoning/chatTypes.js";
import type { Skill } from "../src/skills/skillTypes.js";
import type {
  ConversationMessage,
  CoreConversationEvent,
} from "../src/conversation/conversationTypes.js";

// The conversation manager is tested at the Core's public seam - exactly how the
// Electron main process drives it - by injecting a stub Reasoning Capability that
// records the request it received and replays canned canonical events (or throws).

/** A stub Reasoning Capability: captures each request and streams the queued replies. */
function stubReasoning(options: {
  replies?: string[][];
  failWith?: Error;
}): ReasoningCapability & { requests: CoreChatRequest[] } {
  const requests: CoreChatRequest[] = [];
  let turnIndex = 0;
  return {
    requests,
    async *streamChat(request: CoreChatRequest): AsyncGenerator<CoreChatStreamEvent> {
      requests.push(request);
      if (options.failWith) {
        throw options.failWith;
      }
      const deltasForThisTurn = options.replies?.[turnIndex] ?? [];
      turnIndex += 1;
      for (const delta of deltasForThisTurn) {
        yield { type: "text-delta", text: delta };
      }
      yield { type: "done" };
    },
  };
}

/** Sequential ids ("m1", "m2", ...) so assertions are deterministic. */
function sequentialIds(): () => string {
  let counter = 0;
  return () => `m${(counter += 1)}`;
}

async function drain(
  generator: AsyncGenerator<CoreConversationEvent>,
): Promise<CoreConversationEvent[]> {
  const events: CoreConversationEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("conversationManager.submitUserTurn", () => {
  it("emits the turn's events in order and accumulates the streamed reply", async () => {
    const reasoning = stubReasoning({ replies: [["Hello", " there"]] });
    const manager = createConversationManager({
      reasoningCapability: reasoning,
      generateMessageId: sequentialIds(),
    });

    const events = await drain(
      manager.submitUserTurn({ text: "hi", inputMethod: "text", screenshots: [] }),
    );

    expect(events).toEqual([
      { type: "user-message", message: { id: "m1", role: "user", inputMethod: "text", text: "hi" } },
      { type: "assistant-started", messageId: "m2" },
      { type: "assistant-delta", messageId: "m2", text: "Hello" },
      { type: "assistant-delta", messageId: "m2", text: " there" },
      { type: "assistant-completed", messageId: "m2" },
    ]);

    // The committed history holds the full user turn and the accumulated reply.
    expect(manager.getMessages()).toEqual([
      { id: "m1", role: "user", inputMethod: "text", text: "hi" },
      { id: "m2", role: "assistant", text: "Hello there" },
    ]);
  });

  it("records the input method on the user turn so voice and text share one history", async () => {
    const manager = createConversationManager({
      reasoningCapability: stubReasoning({ replies: [["ok"]] }),
      generateMessageId: sequentialIds(),
    });

    await drain(manager.submitUserTurn({ text: "spoken", inputMethod: "voice", screenshots: [] }));

    expect(manager.getMessages()[0]).toMatchObject({ role: "user", inputMethod: "voice" });
  });

  it("feeds the prior turn back as context on the next turn", async () => {
    const reasoning = stubReasoning({ replies: [["first reply"], ["second reply"]] });
    const manager = createConversationManager({
      reasoningCapability: reasoning,
      generateMessageId: sequentialIds(),
    });

    await drain(manager.submitUserTurn({ text: "first question", inputMethod: "text", screenshots: [] }));
    await drain(manager.submitUserTurn({ text: "second question", inputMethod: "text", screenshots: [] }));

    // The second turn's request carries the whole prior turn as history, then the new question.
    expect(reasoning.requests[1]!.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second question" },
    ]);
  });

  it("rolls the turn back on failure so history never ends on a dangling user turn", async () => {
    const failing = stubReasoning({ failWith: new Error("Vendor rejected the request") });
    const manager = createConversationManager({
      reasoningCapability: failing,
      generateMessageId: sequentialIds(),
    });

    // The generator yields the opening events, then throws when the stream fails.
    const generator = manager.submitUserTurn({ text: "boom", inputMethod: "text", screenshots: [] });
    const opening = [await generator.next(), await generator.next()];
    expect(opening.map((step) => (step.value as CoreConversationEvent).type)).toEqual([
      "user-message",
      "assistant-started",
    ]);
    await expect(generator.next()).rejects.toThrow("Vendor rejected the request");

    // Nothing was committed, so the next turn starts from a clean, well-formed history.
    expect(manager.getMessages()).toEqual([]);
  });

  it("keeps an interrupted (aborted) turn in history so a follow-up merges its context", async () => {
    // Barge-in: the signal aborts mid-stream and the stream throws. Unlike a failure, an
    // interruption is deliberate - the user is adding to the conversation - so the partial
    // turn (their utterance + whatever streamed) is kept for the next turn to build on.
    const controller = new AbortController();
    const interrupted: ReasoningCapability = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async *streamChat(_request: CoreChatRequest): AsyncGenerator<CoreChatStreamEvent> {
        yield { type: "text-delta", text: "Let me look at" };
        controller.abort();
        throw new Error("aborted");
      },
    };
    const manager = createConversationManager({
      reasoningCapability: interrupted,
      generateMessageId: sequentialIds(),
    });

    await expect(
      drain(
        manager.submitUserTurn({
          text: "what's on my screen",
          inputMethod: "voice",
          screenshots: [],
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("aborted");

    // The interrupted turn is retained (merge-on-interrupt), so the next turn's context
    // includes both what the user said and the partial reply.
    expect(manager.getMessages()).toEqual([
      { id: "m1", role: "user", inputMethod: "voice", text: "what's on my screen" },
      { id: "m2", role: "assistant", text: "Let me look at" },
    ]);
  });

  it("keeps history alternating after a failed turn is retried successfully", async () => {
    // First turn fails, second succeeds: the succeeding turn must not carry the failed
    // turn's messages, so its request starts fresh with just the new question.
    let shouldFail = true;
    const requests: CoreChatRequest[] = [];
    const reasoning: ReasoningCapability = {
      async *streamChat(request: CoreChatRequest): AsyncGenerator<CoreChatStreamEvent> {
        requests.push(request);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("temporary failure");
        }
        yield { type: "text-delta", text: "recovered" };
        yield { type: "done" };
      },
    };
    const manager = createConversationManager({
      reasoningCapability: reasoning,
      generateMessageId: sequentialIds(),
    });

    await expect(
      drain(manager.submitUserTurn({ text: "try once", inputMethod: "text", screenshots: [] })),
    ).rejects.toThrow("temporary failure");
    await drain(manager.submitUserTurn({ text: "try again", inputMethod: "text", screenshots: [] }));

    expect(requests[1]!.messages).toEqual([{ role: "user", content: "try again" }]);
    expect(manager.getMessages()).toEqual([
      { id: "m3", role: "user", inputMethod: "text", text: "try again" },
      { id: "m4", role: "assistant", text: "recovered" },
    ]);
  });
});

const RESUMED_HISTORY: ConversationMessage[] = [
  { id: "u1", role: "user", inputMethod: "text", text: "what is this file?" },
  { id: "a1", role: "assistant", text: "it's a config file." },
];

describe("conversationManager.loadConversation (ticket 12 - resume/new)", () => {
  it("seeds committed history so a resumed conversation renders its prior turns", () => {
    const manager = createConversationManager({
      reasoningCapability: stubReasoning({}),
      generateMessageId: sequentialIds(),
    });

    manager.loadConversation(RESUMED_HISTORY);

    expect(manager.getMessages()).toEqual(RESUMED_HISTORY);
  });

  it("answers a resumed turn with the full prior text history as context", async () => {
    const reasoning = stubReasoning({ replies: [["and this?"]] });
    const manager = createConversationManager({
      reasoningCapability: reasoning,
      generateMessageId: sequentialIds(),
    });

    manager.loadConversation(RESUMED_HISTORY);
    await drain(manager.submitUserTurn({ text: "and now?", inputMethod: "text", screenshots: [] }));

    // The resumed history is replayed as plain-text context ahead of the new turn - a
    // resumed conversation keeps its full text history (screenshots were never stored).
    expect(reasoning.requests[0]!.messages).toEqual([
      { role: "user", content: "what is this file?" },
      { role: "assistant", content: "it's a config file." },
      { role: "user", content: "and now?" },
    ]);
  });

  it("starts a fresh conversation clean when loaded with no history", async () => {
    const manager = createConversationManager({
      reasoningCapability: stubReasoning({ replies: [["ok"]] }),
      generateMessageId: sequentialIds(),
    });

    manager.loadConversation(RESUMED_HISTORY);
    manager.loadConversation([]);
    await drain(manager.submitUserTurn({ text: "fresh start", inputMethod: "text", screenshots: [] }));

    // None of the previous conversation's turns survive the reset.
    expect(manager.getMessages().map((message) => message.text)).toEqual(["fresh start", "ok"]);
  });

  it("does not alias the caller's array into committed state", () => {
    const manager = createConversationManager({
      reasoningCapability: stubReasoning({}),
      generateMessageId: sequentialIds(),
    });

    const seed: ConversationMessage[] = [{ id: "u1", role: "user", inputMethod: "text", text: "hi" }];
    manager.loadConversation(seed);
    // Mutating the original seed after loading must not corrupt committed history.
    seed.push({ id: "leak", role: "assistant", text: "leaked" });
    expect(manager.getMessages()).toHaveLength(1);
  });
});

function activeSkill(id: string, title: string, instructions: string): Skill {
  return { id, title, instructions, enabled: true, source: "user" };
}

describe("conversationManager Skill injection (M4-01)", () => {
  it("leaves the turn's system prompt undefined when no Skill is active", async () => {
    // The explicit-invocation path: with nothing turned on, the request carries no system
    // prompt, so each Vendor's canonical-prompt fallback wins - unchanged from before M4.
    const reasoning = stubReasoning({ replies: [["ok"]] });
    const manager = createConversationManager({
      reasoningCapability: reasoning,
      generateMessageId: sequentialIds(),
      getActiveSkills: () => [],
    });

    await drain(manager.submitUserTurn({ text: "hi", inputMethod: "text", screenshots: [] }));

    expect(reasoning.requests[0]!.system).toBeUndefined();
  });

  it("injects an active Skill after the canonical prompt so a stored Skill changes behavior", async () => {
    const reasoning = stubReasoning({ replies: [["aye"]] });
    const manager = createConversationManager({
      reasoningCapability: reasoning,
      generateMessageId: sequentialIds(),
      getActiveSkills: () => [activeSkill("pirate", "Pirate", "answer like a pirate")],
    });

    await drain(manager.submitUserTurn({ text: "hi", inputMethod: "text", screenshots: [] }));

    const system = reasoning.requests[0]!.system;
    expect(system).toBeDefined();
    // The persona/grammar leads and the Skill follows it - additive, never a replacement.
    expect(system!.startsWith(CANONICAL_SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain("## Pirate");
    expect(system).toContain("answer like a pirate");
  });

  it("re-reads active Skills each turn so a toggle takes effect on the next turn", async () => {
    // The store is live: a Skill turned on between turns injects on the following turn
    // with no rebuild, matching how the routing config is re-read per turn.
    const reasoning = stubReasoning({ replies: [["one"], ["two"]] });
    let active: Skill[] = [];
    const manager = createConversationManager({
      reasoningCapability: reasoning,
      generateMessageId: sequentialIds(),
      getActiveSkills: () => active,
    });

    await drain(manager.submitUserTurn({ text: "first", inputMethod: "text", screenshots: [] }));
    active = [activeSkill("terse", "Terse", "one line only")];
    await drain(manager.submitUserTurn({ text: "second", inputMethod: "text", screenshots: [] }));

    expect(reasoning.requests[0]!.system).toBeUndefined();
    expect(reasoning.requests[1]!.system).toContain("one line only");
  });
});
