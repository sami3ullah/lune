import { describe, expect, it } from "vitest";

import { resolveWhisperServerBinaryPath } from "../src/main/transcription/whisperServerBinaryPath";

/**
 * Unit tests for the packaged/dev whisper-server binary resolution (ticket 15). This is
 * the one piece of packaging logic that can be a plain vitest unit test (the rest -
 * signing, notarization, Gatekeeper - is verified manually per the spec's testing
 * decisions): given how the app was launched, it must point at the right binary or at
 * nothing, so Transcription reports not-ready rather than spawning a missing file.
 */
describe("resolveWhisperServerBinaryPath", () => {
  it("uses the bundled Resources copy in a packaged app", () => {
    const resolved = resolveWhisperServerBinaryPath({
      isPackaged: true,
      resourcesPath: "/Applications/Lune.app/Contents/Resources",
      envOverride: undefined,
    });
    expect(resolved).toBe("/Applications/Lune.app/Contents/Resources/whisper-server");
  });

  it("prefers the env override over the bundled copy (packaged debug session)", () => {
    const resolved = resolveWhisperServerBinaryPath({
      isPackaged: true,
      resourcesPath: "/Applications/Lune.app/Contents/Resources",
      envOverride: "/tmp/dev/whisper-server",
    });
    expect(resolved).toBe("/tmp/dev/whisper-server");
  });

  it("uses the env override in a dev (unpackaged) launch", () => {
    const resolved = resolveWhisperServerBinaryPath({
      isPackaged: false,
      resourcesPath: "/unused/in/dev",
      envOverride: "/repo/build/whisper-server",
    });
    expect(resolved).toBe("/repo/build/whisper-server");
  });

  it("returns undefined in dev with no binary built (so whisper reports not-ready)", () => {
    const resolved = resolveWhisperServerBinaryPath({
      isPackaged: false,
      resourcesPath: "/unused/in/dev",
      envOverride: undefined,
    });
    expect(resolved).toBeUndefined();
  });

  it("falls back to the repo's locally-built binary in dev when it exists", () => {
    const resolved = resolveWhisperServerBinaryPath({
      isPackaged: false,
      resourcesPath: "/unused/in/dev",
      envOverride: undefined,
      devFallbackBinaryPath: "/repo/build/whisper-server",
      fileExists: (candidatePath) => candidatePath === "/repo/build/whisper-server",
    });
    expect(resolved).toBe("/repo/build/whisper-server");
  });

  it("ignores the dev fallback when the binary has not been built", () => {
    const resolved = resolveWhisperServerBinaryPath({
      isPackaged: false,
      resourcesPath: "/unused/in/dev",
      envOverride: undefined,
      devFallbackBinaryPath: "/repo/build/whisper-server",
      fileExists: () => false,
    });
    expect(resolved).toBeUndefined();
  });

  it("prefers the env override over the dev fallback", () => {
    const resolved = resolveWhisperServerBinaryPath({
      isPackaged: false,
      resourcesPath: "/unused/in/dev",
      envOverride: "/custom/whisper-server",
      devFallbackBinaryPath: "/repo/build/whisper-server",
      fileExists: () => true,
    });
    expect(resolved).toBe("/custom/whisper-server");
  });

  it("treats a blank env override as unset", () => {
    expect(
      resolveWhisperServerBinaryPath({ isPackaged: false, resourcesPath: "/x", envOverride: "   " }),
    ).toBeUndefined();
    expect(
      resolveWhisperServerBinaryPath({
        isPackaged: true,
        resourcesPath: "/Applications/Lune.app/Contents/Resources",
        envOverride: "  ",
      }),
    ).toBe("/Applications/Lune.app/Contents/Resources/whisper-server");
  });
});
