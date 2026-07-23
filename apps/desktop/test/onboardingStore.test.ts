import { describe, expect, it } from "vitest";

import { OnboardingStore } from "../src/main/onboarding/onboardingStore";

/**
 * Unit tests for the onboarding-complete flag (ticket 14: "Onboarding-complete state
 * persisted; returning users never see onboarding again"). The filesystem is injected,
 * so these exercise the real read/write/tolerance logic without a disk: a fresh profile
 * reads as not-complete, a completed one persists across a reload, and a corrupt/absent
 * file never traps or silently skips a user.
 */

/** A tiny in-memory file seam. */
function fakeFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set("/onboarding.json", initial);
  }
  return {
    read: (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) {
        throw new Error("ENOENT");
      }
      return contents;
    },
    write: (path: string, contents: string) => {
      files.set(path, contents);
    },
    peek: (path: string) => files.get(path),
  };
}

describe("OnboardingStore", () => {
  it("reads a fresh profile (no file) as not complete", () => {
    const fs = fakeFs();
    const store = new OnboardingStore("/onboarding.json", fs.read, fs.write);
    expect(store.isComplete()).toBe(false);
  });

  it("persists completion and reads it back", () => {
    const fs = fakeFs();
    const store = new OnboardingStore("/onboarding.json", fs.read, fs.write);
    store.markComplete();
    expect(store.isComplete()).toBe(true);

    // A fresh instance over the same file sees it too (a returning user).
    const reopened = new OnboardingStore("/onboarding.json", fs.read, fs.write);
    expect(reopened.isComplete()).toBe(true);
  });

  it("reads a corrupt file as not complete", () => {
    const fs = fakeFs("{not json");
    const store = new OnboardingStore("/onboarding.json", fs.read, fs.write);
    expect(store.isComplete()).toBe(false);
  });

  it("treats a file without the completed flag as not complete", () => {
    const fs = fakeFs(JSON.stringify({ somethingElse: true }));
    const store = new OnboardingStore("/onboarding.json", fs.read, fs.write);
    expect(store.isComplete()).toBe(false);
  });

  it("swallows a write failure rather than crashing", () => {
    const store = new OnboardingStore(
      "/onboarding.json",
      () => {
        throw new Error("ENOENT");
      },
      () => {
        throw new Error("EACCES");
      },
    );
    expect(() => store.markComplete()).not.toThrow();
  });
});
