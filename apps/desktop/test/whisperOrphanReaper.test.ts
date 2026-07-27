import { describe, expect, it } from "vitest";

import { parseProcessRows, selectWhisperOrphanPids } from "../src/main/transcription/whisperOrphanReaper";

/**
 * Unit tests for the pure half of startup orphan reaping: parsing `ps` output and
 * selecting exactly the whisper-server pids that belong to *our* binary. The impure
 * `ps`/kill edge (`reapOrphanedWhisperServers`) stays untested, matching
 * `nodeWhisperRuntime.ts`; the selection logic is where the safety lives - it must
 * never target an unrelated process, so it is tested directly.
 */

const BINARY = "/Applications/Lune.app/Contents/Resources/whisper-server";

describe("parseProcessRows", () => {
  it("parses leading-whitespace pid + full command lines and skips malformed rows", () => {
    const output = [
      "  59800 /Applications/Lune.app/Contents/Resources/whisper-server --model /m.bin --port 8771",
      "    123 /usr/bin/node",
      "garbage-with-no-pid",
      "",
    ].join("\n");

    expect(parseProcessRows(output)).toEqual([
      { pid: 59800, command: "/Applications/Lune.app/Contents/Resources/whisper-server --model /m.bin --port 8771" },
      { pid: 123, command: "/usr/bin/node" },
    ]);
  });
});

describe("selectWhisperOrphanPids", () => {
  it("selects whisper-server processes launched from our exact binary", () => {
    const rows = [
      { pid: 100, command: `${BINARY} --model /m.bin --port 8771 --host 127.0.0.1` },
      { pid: 101, command: `${BINARY} --model /other.bin --port 8771` },
      { pid: 200, command: "/usr/bin/node index.js" },
    ];
    expect(selectWhisperOrphanPids({ rows, serverBinaryPath: BINARY })).toEqual([100, 101]);
  });

  it("matches the binary invoked with no arguments", () => {
    const rows = [{ pid: 100, command: BINARY }];
    expect(selectWhisperOrphanPids({ rows, serverBinaryPath: BINARY })).toEqual([100]);
  });

  it("does not match a different binary whose path merely starts with ours", () => {
    const rows = [
      { pid: 100, command: `${BINARY}-old --port 8771` },
      { pid: 101, command: `${BINARY}x` },
      { pid: 102, command: "/other/app/whisper-server --port 8771" },
    ];
    expect(selectWhisperOrphanPids({ rows, serverBinaryPath: BINARY })).toEqual([]);
  });

  it("excludes ownPids so it can never target the live process", () => {
    const rows = [
      { pid: 100, command: `${BINARY} --port 8771` },
      { pid: 999, command: `${BINARY} --port 8771` },
    ];
    expect(selectWhisperOrphanPids({ rows, serverBinaryPath: BINARY, ownPids: [999] })).toEqual([100]);
  });
});
