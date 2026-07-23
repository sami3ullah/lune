import { describe, expect, it } from "vitest";

import {
  ChecksumMismatchError,
  downloadArtifact,
  type DownloadProgress,
} from "../src/provisioning/download.js";
import type { PinnedArtifact } from "../src/provisioning/manifest.js";
import { FakeDownloadGateway, FakeFileSystem, sha256Hex } from "./provisioningFakes.js";

/**
 * Seam-3 tests for the resumable, checksum-verified download (ADR-0009). The network
 * and filesystem are stubbed, so these exercise resume, corruption recovery, and
 * atomic finalize deterministically.
 */

const ARTIFACT_BODY = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
const DESTINATION = "/models/whisper/ggml.bin";
const PARTIAL = `${DESTINATION}.part`;

function artifactFor(body: Uint8Array): PinnedArtifact {
  return {
    id: "whisper-large-v3-turbo",
    displayName: "whisper",
    relativePath: "whisper/ggml.bin",
    url: "https://models.lune.local/whisper.bin",
    sha256: sha256Hex(body),
    sizeBytes: body.byteLength,
    version: "1.0",
  };
}

describe("downloadArtifact", () => {
  it("downloads, verifies, and atomically finalizes to the destination", async () => {
    const fileSystem = new FakeFileSystem();
    const download = new FakeDownloadGateway();
    const artifact = artifactFor(ARTIFACT_BODY);
    download.setBody(artifact.url, ARTIFACT_BODY);

    await downloadArtifact({ artifact, destinationPath: DESTINATION, download, fileSystem });

    expect(fileSystem.peek(DESTINATION)).toEqual(ARTIFACT_BODY);
    // The .part file is renamed away, not left behind.
    expect(await fileSystem.exists(PARTIAL)).toBe(false);
  });

  it("reports progress up to the total", async () => {
    const fileSystem = new FakeFileSystem();
    const download = new FakeDownloadGateway();
    const artifact = artifactFor(ARTIFACT_BODY);
    download.setBody(artifact.url, ARTIFACT_BODY);

    const progressEvents: DownloadProgress[] = [];
    await downloadArtifact({
      artifact,
      destinationPath: DESTINATION,
      download,
      fileSystem,
      onProgress: (progress) => progressEvents.push(progress),
    });

    const finalProgress = progressEvents[progressEvents.length - 1];
    expect(finalProgress.downloadedBytes).toBe(ARTIFACT_BODY.byteLength);
    expect(finalProgress.totalBytes).toBe(ARTIFACT_BODY.byteLength);
  });

  it("skips entirely when a verified copy already exists (idempotent)", async () => {
    const fileSystem = new FakeFileSystem();
    const download = new FakeDownloadGateway();
    const artifact = artifactFor(ARTIFACT_BODY);
    download.setBody(artifact.url, ARTIFACT_BODY);
    fileSystem.seedFile(DESTINATION, ARTIFACT_BODY);

    await downloadArtifact({ artifact, destinationPath: DESTINATION, download, fileSystem });

    expect(download.calls).toHaveLength(0);
  });

  it("resumes from the partial file rather than restarting after an interruption", async () => {
    const fileSystem = new FakeFileSystem();
    const download = new FakeDownloadGateway();
    const artifact = artifactFor(ARTIFACT_BODY);
    download.setBody(artifact.url, ARTIFACT_BODY);

    // First run is interrupted after 3 bytes.
    download.interruptNextAfterBytes(artifact.url, 3);
    await expect(
      downloadArtifact({ artifact, destinationPath: DESTINATION, download, fileSystem }),
    ).rejects.toThrow();
    expect(await fileSystem.existingSize(PARTIAL)).toBe(3);

    // Second run resumes from byte 3 and completes.
    await downloadArtifact({ artifact, destinationPath: DESTINATION, download, fileSystem });

    expect(fileSystem.peek(DESTINATION)).toEqual(ARTIFACT_BODY);
    expect(download.calls[1].resumeFrom).toEqual({ fromByte: 3 });
  });

  it("rejects a corrupted download and re-fetches it clean", async () => {
    const fileSystem = new FakeFileSystem();
    const download = new FakeDownloadGateway();
    const artifact = artifactFor(ARTIFACT_BODY);
    download.setBody(artifact.url, ARTIFACT_BODY);
    download.corruptNextResponse(artifact.url);

    await downloadArtifact({ artifact, destinationPath: DESTINATION, download, fileSystem });

    // Corrupt first attempt, clean re-fetch: two network calls, correct final file.
    expect(download.calls).toHaveLength(2);
    expect(fileSystem.peek(DESTINATION)).toEqual(ARTIFACT_BODY);
  });

  it("throws ChecksumMismatchError and leaves no partial when the file never verifies", async () => {
    const fileSystem = new FakeFileSystem();
    const download = new FakeDownloadGateway();
    // The pinned checksum expects different bytes than the server will ever serve.
    const artifact = { ...artifactFor(ARTIFACT_BODY), sha256: sha256Hex(new Uint8Array([1, 2, 3])) };
    download.setBody(artifact.url, ARTIFACT_BODY);

    await expect(
      downloadArtifact({ artifact, destinationPath: DESTINATION, download, fileSystem }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);

    expect(await fileSystem.exists(DESTINATION)).toBe(false);
    expect(await fileSystem.exists(PARTIAL)).toBe(false);
  });
});
