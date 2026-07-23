/**
 * The Seam-3 boundaries of Provisioning (spec Testing Decisions, Seam 3): the
 * network and filesystem layers are expressed as injectable gateways so
 * Provisioning logic - resume, checksum verification, idempotent recovery,
 * preflight - is tested deterministically with these stubbed, and no real
 * multi-gigabyte download or disk access is touched.
 *
 * Each gateway is the *only* way Provisioning reaches the outside world, so a fake
 * gateway in a test fully controls what Provisioning sees. The Core owns these
 * interfaces but no real implementation: the Electron main process injects the
 * Node-backed impls (fetch, fs, statfs, dns), keeping the Core transport-agnostic
 * (developer story 45).
 */

/** A byte range already-present on disk, so a download can resume from `fromByte`. */
export interface ResumeFrom {
  fromByte: number;
}

/**
 * Streams the bytes of a URL, optionally resuming from a byte offset via an HTTP
 * Range request. Yields chunks so the caller can write incrementally and report
 * progress. Implementations must throw if the server ignores a Range request
 * (returns 200 instead of 206) so the caller never silently corrupts a resumed
 * file by appending a full body to a partial one.
 */
export interface RangeDownloadGateway {
  /**
   * @param url         the pinned artifact URL
   * @param resumeFrom  when set, requests `Range: bytes=<fromByte>-` and expects 206
   * @returns an async iterable of byte chunks, plus the total size the server reports
   */
  openDownload(url: string, resumeFrom?: ResumeFrom): Promise<DownloadStream>;
}

/** An in-progress download: the chunk stream plus the total content length. */
export interface DownloadStream {
  /** Total bytes of the *complete* artifact (not just the resumed remainder). */
  totalBytes: number;
  /** The bytes, streamed. For a resumed download these are only the remaining bytes. */
  chunks: AsyncIterable<Uint8Array>;
}

/**
 * The filesystem operations Provisioning needs. Deliberately small and
 * append/rename oriented so resume (append to a `.part` file) and atomic finalize
 * (rename `.part` -> final) are expressible without exposing all of `fs`.
 */
export interface FileSystemGateway {
  /** Bytes already written to `path`, or 0 if it doesn't exist. Drives resume. */
  existingSize(path: string): Promise<number>;
  /** Whether a file exists at `path`. */
  exists(path: string): Promise<boolean>;
  /** Creates a directory (and parents) if absent. */
  ensureDirectory(path: string): Promise<void>;
  /** Appends bytes to `path`, creating it if needed. Used to grow the `.part` file. */
  appendBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Deletes `path` if present (e.g. discarding a corrupted partial). */
  remove(path: string): Promise<void>;
  /** Atomically renames `fromPath` to `toPath` (the finalize step). */
  rename(fromPath: string, toPath: string): Promise<void>;
  /** Streams a finished file's bytes for checksum verification without buffering it all. */
  readForHashing(path: string): AsyncIterable<Uint8Array>;
}

/** Reports free disk space so the preflight can refuse before starting. */
export interface DiskSpaceProbe {
  /** Free bytes available on the volume backing `path`. */
  freeBytes(path: string): Promise<number>;
}

/** Reports whether the network is reachable, so preflight fails clearly offline. */
export interface NetworkProbe {
  isOnline(): Promise<boolean>;
}

/** All the gateways Provisioning depends on, injected together. */
export interface ProvisioningGateways {
  download: RangeDownloadGateway;
  fileSystem: FileSystemGateway;
  diskSpace: DiskSpaceProbe;
  network: NetworkProbe;
}
