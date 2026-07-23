import { createHash } from "node:crypto";

import type {
  DiskSpaceProbe,
  DownloadStream,
  FileSystemGateway,
  NetworkProbe,
  ProvisioningGateways,
  RangeDownloadGateway,
  ResumeFrom,
} from "../src/provisioning/gateways.js";

/**
 * Seam-3 test doubles for Provisioning (spec Testing Decisions, Seam 3): in-memory
 * fakes for the network, filesystem, and disk layers so Provisioning logic is
 * exercised deterministically without a real download or disk. Ported from v1's
 * `provisioningFakes.ts`, minus the LM Studio gateway (Lune has no local Reasoning).
 */

/** The lowercase-hex SHA-256 of some bytes, matching what the real verifier computes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** An in-memory filesystem keyed by absolute path. */
export class FakeFileSystem implements FileSystemGateway {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();

  /** Seeds a file directly (e.g. a pre-existing verified copy or a partial). */
  seedFile(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
  }

  /** Reads a file's bytes for assertions, or undefined if absent. */
  peek(path: string): Uint8Array | undefined {
    return this.files.get(path);
  }

  async existingSize(path: string): Promise<number> {
    return this.files.get(path)?.byteLength ?? 0;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async ensureDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }

  async appendBytes(path: string, bytes: Uint8Array): Promise<void> {
    const existing = this.files.get(path) ?? new Uint8Array(0);
    const combined = new Uint8Array(existing.byteLength + bytes.byteLength);
    combined.set(existing, 0);
    combined.set(bytes, existing.byteLength);
    this.files.set(path, combined);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const bytes = this.files.get(fromPath);
    if (bytes === undefined) {
      throw new Error(`FakeFileSystem: cannot rename missing file ${fromPath}`);
    }
    this.files.set(toPath, bytes);
    this.files.delete(fromPath);
  }

  async *readForHashing(path: string): AsyncIterable<Uint8Array> {
    const bytes = this.files.get(path);
    if (bytes === undefined) {
      throw new Error(`FakeFileSystem: cannot read missing file ${path}`);
    }
    // Yield in two chunks to exercise streaming hashing.
    const midpoint = Math.floor(bytes.byteLength / 2);
    yield bytes.subarray(0, midpoint);
    yield bytes.subarray(midpoint);
  }
}

/**
 * A download gateway serving canned bodies per URL. Records every call (so tests can
 * assert reuse skipped the network) and can be told to fail once (to exercise
 * interrupted-then-resumed downloads) or to serve corrupt bytes.
 */
export class FakeDownloadGateway implements RangeDownloadGateway {
  readonly calls: Array<{ url: string; resumeFrom?: ResumeFrom }> = [];
  private readonly bodiesByUrl = new Map<string, Uint8Array>();
  /** URLs whose next served body should be corrupt (wrong bytes) exactly once. */
  private corruptOnceUrls = new Set<string>();
  /** After how many delivered bytes to throw, per URL, to simulate an interruption. */
  private interruptAfterBytesByUrl = new Map<string, number>();

  setBody(url: string, bytes: Uint8Array): void {
    this.bodiesByUrl.set(url, bytes);
  }

  /** Serve corrupt bytes the next time this URL is fetched (then serve correctly). */
  corruptNextResponse(url: string): void {
    this.corruptOnceUrls.add(url);
  }

  /** Throw mid-stream after delivering `byteCount` bytes on the next fetch of `url`. */
  interruptNextAfterBytes(url: string, byteCount: number): void {
    this.interruptAfterBytesByUrl.set(url, byteCount);
  }

  async openDownload(url: string, resumeFrom?: ResumeFrom): Promise<DownloadStream> {
    this.calls.push({ url, resumeFrom });

    const fullBody = this.bodiesByUrl.get(url);
    if (fullBody === undefined) {
      throw new Error(`FakeDownloadGateway: no body configured for ${url}`);
    }

    const totalBytes = fullBody.byteLength;
    const startByte = resumeFrom?.fromByte ?? 0;

    // One-shot corruption: flip the served bytes so the checksum fails.
    let servedBody = fullBody.subarray(startByte);
    if (this.corruptOnceUrls.has(url)) {
      this.corruptOnceUrls.delete(url);
      servedBody = servedBody.map((byte) => byte ^ 0xff);
    }

    const interruptAfterBytes = this.interruptAfterBytesByUrl.get(url);
    if (interruptAfterBytes !== undefined) {
      this.interruptAfterBytesByUrl.delete(url);
    }

    async function* streamChunks(): AsyncIterable<Uint8Array> {
      // Deliver in small chunks so resume/interrupt points land mid-body.
      const chunkSize = Math.max(1, Math.ceil(servedBody.byteLength / 4));
      let deliveredBytes = 0;
      for (let offset = 0; offset < servedBody.byteLength; offset += chunkSize) {
        const chunk = servedBody.subarray(offset, offset + chunkSize);
        if (interruptAfterBytes !== undefined && deliveredBytes + chunk.byteLength > interruptAfterBytes) {
          const partialLength = interruptAfterBytes - deliveredBytes;
          if (partialLength > 0) {
            yield chunk.subarray(0, partialLength);
          }
          throw new Error("FakeDownloadGateway: simulated network interruption");
        }
        yield chunk;
        deliveredBytes += chunk.byteLength;
      }
    }

    return { totalBytes, chunks: streamChunks() };
  }
}

export class FakeDiskSpaceProbe implements DiskSpaceProbe {
  constructor(public freeBytesValue: number) {}
  async freeBytes(): Promise<number> {
    return this.freeBytesValue;
  }
}

export class FakeNetworkProbe implements NetworkProbe {
  constructor(public online: boolean) {}
  async isOnline(): Promise<boolean> {
    return this.online;
  }
}

/** Assembles a full gateway set from the fakes, with sensible online/ample defaults. */
export function makeFakeGateways(overrides?: Partial<ProvisioningGateways>): {
  gateways: ProvisioningGateways;
  fileSystem: FakeFileSystem;
  download: FakeDownloadGateway;
  diskSpace: FakeDiskSpaceProbe;
  network: FakeNetworkProbe;
} {
  const fileSystem = (overrides?.fileSystem as FakeFileSystem) ?? new FakeFileSystem();
  const download = (overrides?.download as FakeDownloadGateway) ?? new FakeDownloadGateway();
  const diskSpace = (overrides?.diskSpace as FakeDiskSpaceProbe) ?? new FakeDiskSpaceProbe(1_000_000_000_000);
  const network = (overrides?.network as FakeNetworkProbe) ?? new FakeNetworkProbe(true);

  return {
    gateways: { download, fileSystem, diskSpace, network },
    fileSystem,
    download,
    diskSpace,
    network,
  };
}
