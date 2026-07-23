import { describe, expect, it, vi } from "vitest";
import {
  ConversationHistoryStore,
  MAX_CONVERSATIONS,
  deriveConversationTitle,
  pruneToCap,
  type StoredConversation,
} from "../src/main/conversationHistoryStore";
import type { ConversationMessage } from "@lune/core";

// The durable last-10 store (ticket 12). Persistence is a Shell/platform concern, so it
// lives here over an injected filesystem seam (the same style as PillPositionStore),
// and its pruning is exercised as plain logic - the acceptance criterion "pruning logic
// unit-tested". The Core still owns the *active* conversation; this owns the set.

const FILE_PATH = "/tmp/lune-conversations.json";

function fileMissing(): string {
  throw new Error("ENOENT");
}

/** A minimal well-formed turn (one user message, one assistant reply). */
function turn(userText: string, replyText: string, id: string): ConversationMessage[] {
  return [
    { id: `${id}-u`, role: "user", inputMethod: "text", text: userText },
    { id: `${id}-a`, role: "assistant", text: replyText },
  ];
}

/** A stored conversation stamped at a fixed update time, for pruning tests. */
function stored(id: string, updatedAtMs: number): StoredConversation {
  return { id, createdAtMs: updatedAtMs, updatedAtMs, messages: turn("hi", "hello", id) };
}

describe("pruneToCap", () => {
  it("keeps every conversation when under the cap", () => {
    const conversations = [stored("a", 1), stored("b", 2)];
    expect(pruneToCap(conversations, MAX_CONVERSATIONS).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("drops the oldest so exactly the cap survives (the 11th evicts the 1st)", () => {
    // Eleven conversations, updated in ascending time order c0..c10.
    const conversations = Array.from({ length: MAX_CONVERSATIONS + 1 }, (_unused, index) =>
      stored(`c${index}`, index + 1),
    );

    const kept = pruneToCap(conversations, MAX_CONVERSATIONS);

    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    // The single oldest (c0) is gone; the rest survive.
    expect(kept.map((c) => c.id)).not.toContain("c0");
    expect(kept.map((c) => c.id).sort()).toEqual(
      Array.from({ length: MAX_CONVERSATIONS }, (_unused, index) => `c${index + 1}`).sort(),
    );
  });

  it("prunes by most-recent update, not insertion order", () => {
    // A conversation inserted first but updated most recently must survive.
    const conversations = [
      stored("old-but-active", 100),
      ...Array.from({ length: MAX_CONVERSATIONS }, (_unused, index) => stored(`n${index}`, index + 1)),
    ];

    const keptIds = pruneToCap(conversations, MAX_CONVERSATIONS).map((c) => c.id);

    expect(keptIds).toContain("old-but-active");
    expect(keptIds).not.toContain("n0"); // the genuinely-oldest (updatedAtMs 1) is evicted
  });
});

describe("deriveConversationTitle", () => {
  it("uses the first user turn's text", () => {
    expect(deriveConversationTitle(turn("What is on my screen?", "...", "t"))).toBe(
      "What is on my screen?",
    );
  });

  it("truncates a long first turn with an ellipsis", () => {
    const long = "a".repeat(200);
    const title = deriveConversationTitle(turn(long, "...", "t"));
    expect(title.length).toBeLessThan(long.length);
    expect(title.endsWith("...")).toBe(true);
  });

  it("falls back to a placeholder when there is no user text yet", () => {
    expect(deriveConversationTitle([])).toBe("New conversation");
  });
});

describe("ConversationHistoryStore.load", () => {
  it("starts empty on first run when the file is absent", () => {
    const store = new ConversationHistoryStore(FILE_PATH, fileMissing, () => {}, () => 0);
    expect(store.list()).toEqual([]);
  });

  it("starts empty (never throws) when the file is corrupt", () => {
    const store = new ConversationHistoryStore(FILE_PATH, () => "not json {", () => {}, () => 0);
    expect(store.list()).toEqual([]);
  });

  it("round-trips persisted conversations across a restart, newest first", () => {
    const persisted = JSON.stringify({
      version: 1,
      conversations: [stored("older", 10), stored("newer", 20)],
    });
    const store = new ConversationHistoryStore(FILE_PATH, () => persisted, () => {}, () => 0);

    // A resumable conversation survives the restart; the dropdown lists newest first.
    expect(store.list().map((summary) => summary.id)).toEqual(["newer", "older"]);
    expect(store.get("older")?.messages).toEqual(turn("hi", "hello", "older"));
  });
});

describe("ConversationHistoryStore.save", () => {
  it("creates a new conversation, then updates it in place on the next turn", () => {
    let now = 1000;
    const writeFile = vi.fn();
    const store = new ConversationHistoryStore(FILE_PATH, fileMissing, writeFile, () => now);

    store.save("conv-1", turn("first", "reply one", "1"));
    expect(store.list().map((s) => s.id)).toEqual(["conv-1"]);

    now = 2000;
    store.save("conv-1", [...turn("first", "reply one", "1"), ...turn("second", "reply two", "2")]);

    // Still one conversation (updated, not duplicated), with the fuller history.
    expect(store.list()).toHaveLength(1);
    expect(store.get("conv-1")?.messages).toHaveLength(4);
    expect(store.get("conv-1")?.updatedAtMs).toBe(2000);
    expect(store.get("conv-1")?.createdAtMs).toBe(1000);
  });

  it("persists text only - no audio, no image data ever reaches disk", () => {
    let written = "";
    const store = new ConversationHistoryStore(
      FILE_PATH,
      fileMissing,
      (_path, contents) => {
        written = contents;
      },
      () => 0,
    );

    store.save("conv-1", turn("what is this button?", "it saves your file", "1"));

    // The store's shape carries only role/text/id/inputMethod; assert the serialized
    // bytes hold the transcript and reply and nothing image/audio-shaped.
    expect(written).toContain("what is this button?");
    expect(written).toContain("it saves your file");
    expect(written).not.toMatch(/base64|image|audio|screenshot|wav|png|jpeg/i);
  });

  it("silently evicts the oldest when an 11th conversation is saved", () => {
    let now = 0;
    const store = new ConversationHistoryStore(FILE_PATH, fileMissing, () => {}, () => now);

    for (let index = 0; index < MAX_CONVERSATIONS; index += 1) {
      now = index + 1;
      store.save(`conv-${index}`, turn(`q${index}`, `a${index}`, `${index}`));
    }
    expect(store.list()).toHaveLength(MAX_CONVERSATIONS);

    // The 11th conversation pushes the count over the cap; the oldest (conv-0) is gone.
    now = 100;
    store.save("conv-11th", turn("newest", "reply", "x"));

    expect(store.list()).toHaveLength(MAX_CONVERSATIONS);
    expect(store.get("conv-0")).toBeNull();
    expect(store.get("conv-11th")).not.toBeNull();
  });

  it("ignores an empty turn so a brand-new conversation is not persisted before it has content", () => {
    const writeFile = vi.fn();
    const store = new ConversationHistoryStore(FILE_PATH, fileMissing, writeFile, () => 0);

    store.save("conv-empty", []);

    expect(store.list()).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("swallows a write failure rather than crashing the running app", () => {
    const store = new ConversationHistoryStore(
      FILE_PATH,
      fileMissing,
      () => {
        throw new Error("EROFS: read-only file system");
      },
      () => 0,
    );
    expect(() => store.save("conv-1", turn("hi", "hello", "1"))).not.toThrow();
  });
});
