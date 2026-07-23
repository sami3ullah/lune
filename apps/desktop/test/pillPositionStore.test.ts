import { describe, expect, it, vi } from "vitest";
import { PillPositionStore } from "../src/main/pillPositionStore";

// The store is exercised over injected in-memory filesystem fakes (the same style
// as v1's provisioning gateways) so the persistence contract is pinned without
// touching a real disk.

const FILE_PATH = "/tmp/pill-position.json";

function fileMissing(): string {
  throw new Error("ENOENT");
}

describe("PillPositionStore.load", () => {
  it("returns the saved anchor round-tripped through the file", () => {
    const store = new PillPositionStore(
      FILE_PATH,
      () => JSON.stringify({ x: 720, y: 33 }),
      () => {},
    );
    expect(store.load()).toEqual({ x: 720, y: 33 });
  });

  it("returns null on first run when the file does not exist", () => {
    const store = new PillPositionStore(FILE_PATH, fileMissing, () => {});
    expect(store.load()).toBeNull();
  });

  it("returns null (not a throw) when the file is not valid JSON", () => {
    const store = new PillPositionStore(FILE_PATH, () => "not json {", () => {});
    expect(store.load()).toBeNull();
  });

  it("returns null when the JSON is well-formed but not a valid anchor", () => {
    const store = new PillPositionStore(
      FILE_PATH,
      () => JSON.stringify({ x: "left", y: 33 }),
      () => {},
    );
    expect(store.load()).toBeNull();
  });
});

describe("PillPositionStore.save", () => {
  it("writes the anchor as JSON to the configured path", () => {
    const writeFile = vi.fn();
    const store = new PillPositionStore(FILE_PATH, fileMissing, writeFile);
    store.save({ x: 640, y: 40 });
    expect(writeFile).toHaveBeenCalledWith(FILE_PATH, JSON.stringify({ x: 640, y: 40 }));
  });

  it("swallows a write failure rather than crashing the running app", () => {
    const store = new PillPositionStore(FILE_PATH, fileMissing, () => {
      throw new Error("EROFS: read-only file system");
    });
    expect(() => store.save({ x: 640, y: 40 })).not.toThrow();
  });
});
