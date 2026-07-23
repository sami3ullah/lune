import { createHash } from "node:crypto";

import type { FileSystemGateway } from "./gateways.js";
import type { PinnedArtifact } from "./manifest.js";

/**
 * Checksum verification (ADR-0009): a downloaded artifact is only trusted once its
 * SHA-256 matches the pinned value. This is what makes a corrupted download
 * detectable rather than silently producing a broken model, and it is the same
 * check a Capability consults to decide it is "ready" - a half-written or wrong file
 * never verifies, so it is never used.
 *
 * The bytes are streamed through the hash (via the filesystem gateway) rather than
 * read into memory, so verifying a multi-gigabyte weight file stays cheap.
 */

/** Computes the lowercase-hex SHA-256 of a file, streaming its bytes. */
export async function computeSha256(
  fileSystem: FileSystemGateway,
  path: string,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fileSystem.readForHashing(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Whether the file at `path` exists and matches the artifact's pinned SHA-256.
 * A missing file is simply not verified (returns false) rather than an error, so
 * callers can use this both to gate "ready" and to decide whether to (re)download.
 */
export async function isArtifactVerified(
  fileSystem: FileSystemGateway,
  path: string,
  artifact: PinnedArtifact,
): Promise<boolean> {
  if (!(await fileSystem.exists(path))) {
    return false;
  }
  const actualSha256 = await computeSha256(fileSystem, path);
  return actualSha256.toLowerCase() === artifact.sha256.toLowerCase();
}
