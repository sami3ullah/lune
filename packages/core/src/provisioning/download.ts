import type { FileSystemGateway, RangeDownloadGateway } from "./gateways.js";
import type { PinnedArtifact } from "./manifest.js";
import { isArtifactVerified } from "./verify.js";

/**
 * Downloads one pinned artifact robustly (ADR-0009): resumable, checksum-verified,
 * and finalized atomically.
 *
 *   - **Resumable:** bytes land in a `<file>.part` sidecar; an interrupted run
 *     resumes from the partial file's current size via an HTTP Range request
 *     rather than starting over.
 *   - **Checksum-verified:** once the bytes are in, the `.part` file's SHA-256 is
 *     checked against the pinned value. A mismatch (corruption, a truncated
 *     resume, a changed upstream) is rejected and the artifact is re-fetched once
 *     from scratch before giving up.
 *   - **Atomic finalize:** only a verified `.part` file is renamed to the final
 *     path, so a Capability never sees a half-written or wrong file (it would fail
 *     verification and read as "not ready").
 *
 * Progress is reported per chunk so the UI can show a live bar over the multi-
 * gigabyte download.
 */

/** Live progress for one artifact download. */
export interface DownloadProgress {
  artifactId: string;
  downloadedBytes: number;
  totalBytes: number;
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void;

export interface DownloadArtifactOptions {
  artifact: PinnedArtifact;
  /** Absolute path where the finished, verified file must end up. */
  destinationPath: string;
  download: RangeDownloadGateway;
  fileSystem: FileSystemGateway;
  onProgress?: DownloadProgressCallback;
  /**
   * Polled between chunks so a user cancel stops the download promptly. The partial
   * `.part` file is left in place, so a later run resumes from where cancel hit
   * rather than restarting.
   */
  isCancelled?: () => boolean;
}

/** Thrown when an artifact still fails checksum verification after a fresh re-fetch. */
export class ChecksumMismatchError extends Error {
  constructor(public readonly artifactId: string) {
    super(`Checksum verification failed for artifact "${artifactId}" after re-fetch`);
    this.name = "ChecksumMismatchError";
  }
}

/** Thrown when a download is stopped by a user cancel. Leaves the partial file for resume. */
export class ProvisioningCancelledError extends Error {
  constructor() {
    super("Provisioning was cancelled");
    this.name = "ProvisioningCancelledError";
  }
}

/**
 * Ensures the artifact is present and verified at `destinationPath`. A no-op if a
 * verified copy already exists (idempotent). Returns nothing; throws on an
 * unrecoverable failure (network error surfaced from the gateway, or a persistent
 * checksum mismatch).
 */
export async function downloadArtifact(options: DownloadArtifactOptions): Promise<void> {
  const { artifact, destinationPath, fileSystem } = options;

  // Already fully provisioned and valid? Nothing to do (idempotent re-run).
  if (await fileSystem.exists(destinationPath)) {
    if (await isArtifactVerified(fileSystem, destinationPath, artifact)) {
      options.onProgress?.({
        artifactId: artifact.id,
        downloadedBytes: artifact.sizeBytes,
        totalBytes: artifact.sizeBytes,
      });
      return;
    }
    // A file that doesn't match the pinned checksum is left in place, not deleted:
    // the new bytes are staged in `.part` and only rename over it once they verify,
    // so a currently-installed known-good file is never destroyed before its
    // replacement is proven good (ADR-0009).
  }

  const partialPath = `${destinationPath}.part`;
  await ensureParentDirectory(fileSystem, destinationPath);

  // First attempt: resume from whatever partial bytes already exist.
  await fetchIntoPartialFile(options, partialPath, { allowResume: true });

  if (await isArtifactVerified(fileSystem, partialPath, artifact)) {
    await fileSystem.rename(partialPath, destinationPath);
    return;
  }

  // The bytes we have are corrupt or stale: discard and re-fetch from scratch once.
  await fileSystem.remove(partialPath);
  await fetchIntoPartialFile(options, partialPath, { allowResume: false });

  if (await isArtifactVerified(fileSystem, partialPath, artifact)) {
    await fileSystem.rename(partialPath, destinationPath);
    return;
  }

  // Still bad after a clean re-fetch - don't leave a corrupt partial lying around.
  await fileSystem.remove(partialPath);
  throw new ChecksumMismatchError(artifact.id);
}

/**
 * Streams the artifact into its `.part` file, resuming from the partial file's
 * current size when `allowResume` is set and some bytes already exist. Reports
 * progress against the artifact's total as bytes land.
 */
async function fetchIntoPartialFile(
  options: DownloadArtifactOptions,
  partialPath: string,
  { allowResume }: { allowResume: boolean },
): Promise<void> {
  const { artifact, download, fileSystem, onProgress } = options;

  const alreadyDownloadedBytes = allowResume ? await fileSystem.existingSize(partialPath) : 0;

  // Nothing left to fetch: the partial file is already complete-length; let the
  // checksum step decide whether it's actually valid.
  if (alreadyDownloadedBytes >= artifact.sizeBytes && artifact.sizeBytes > 0) {
    return;
  }

  const stream = await download.openDownload(
    artifact.url,
    alreadyDownloadedBytes > 0 ? { fromByte: alreadyDownloadedBytes } : undefined,
  );

  let downloadedBytes = alreadyDownloadedBytes;
  onProgress?.({ artifactId: artifact.id, downloadedBytes, totalBytes: stream.totalBytes });

  for await (const chunk of stream.chunks) {
    if (options.isCancelled?.()) {
      // Leave the partial file so a later run resumes rather than restarts.
      throw new ProvisioningCancelledError();
    }
    await fileSystem.appendBytes(partialPath, chunk);
    downloadedBytes += chunk.byteLength;
    onProgress?.({ artifactId: artifact.id, downloadedBytes, totalBytes: stream.totalBytes });
  }
}

/** Ensures the directory that will hold `filePath` exists. */
async function ensureParentDirectory(fileSystem: FileSystemGateway, filePath: string): Promise<void> {
  const lastSeparatorIndex = filePath.lastIndexOf("/");
  if (lastSeparatorIndex > 0) {
    await fileSystem.ensureDirectory(filePath.slice(0, lastSeparatorIndex));
  }
}
