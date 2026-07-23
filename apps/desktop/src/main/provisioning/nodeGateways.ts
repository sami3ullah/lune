import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";

import type {
  DiskSpaceProbe,
  DownloadStream,
  FileSystemGateway,
  NetworkProbe,
  ProvisioningGateways,
  RangeDownloadGateway,
  ResumeFrom,
} from "@lune/core";

/**
 * The real, Node-backed implementations of the Provisioning gateways (ticket 08).
 * These are the production counterparts to the in-memory Seam-3 fakes: the actual
 * filesystem, HTTP range downloads, disk-space probe, and network probe. They live
 * in the Electron main process - never in @lune/core - so the Core stays pure and
 * transport-agnostic (developer story 45): the Core defines the gateway interfaces
 * and all the Provisioning logic above them; this file is the thin platform edge.
 *
 * They are intentionally thin - all Provisioning logic lives above this boundary,
 * tested against the fakes - so they need no unit tests of their own.
 */

/** HTTP range downloads via the platform `fetch`. */
class NodeRangeDownloadGateway implements RangeDownloadGateway {
  async openDownload(url: string, resumeFrom?: ResumeFrom): Promise<DownloadStream> {
    const headers: Record<string, string> = {};
    if (resumeFrom !== undefined && resumeFrom.fromByte > 0) {
      headers["range"] = `bytes=${resumeFrom.fromByte}-`;
    }

    const response = await fetch(url, { headers });
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
    }

    // If we asked to resume but the server sent the whole file (200, not 206),
    // appending would corrupt the partial file - refuse rather than corrupt.
    if (resumeFrom !== undefined && resumeFrom.fromByte > 0 && response.status !== 206) {
      throw new Error(`Server ignored range request for ${url} (status ${response.status})`);
    }

    const totalBytes = totalBytesFromHeaders(response, resumeFrom);
    return { totalBytes, chunks: streamWebBody(response.body) };
  }
}

/** Resolves the full artifact size from a 206 Content-Range or a plain Content-Length. */
function totalBytesFromHeaders(response: Response, resumeFrom?: ResumeFrom): number {
  const contentRange = response.headers.get("content-range");
  if (contentRange !== null) {
    // Format: "bytes <start>-<end>/<total>"
    const total = Number.parseInt(contentRange.split("/")[1] ?? "", 10);
    if (!Number.isNaN(total)) {
      return total;
    }
  }
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const remainderBytes = Number.isNaN(contentLength) ? 0 : contentLength;
  return remainderBytes + (resumeFrom?.fromByte ?? 0);
}

async function* streamWebBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class NodeFileSystemGateway implements FileSystemGateway {
  async existingSize(filePath: string): Promise<number> {
    try {
      return (await fs.stat(filePath)).size;
    } catch {
      return 0;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDirectory(directoryPath: string): Promise<void> {
    await fs.mkdir(directoryPath, { recursive: true });
  }

  async appendBytes(filePath: string, bytes: Uint8Array): Promise<void> {
    await fs.appendFile(filePath, bytes);
  }

  async remove(filePath: string): Promise<void> {
    await fs.rm(filePath, { force: true });
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await fs.rename(fromPath, toPath);
  }

  async *readForHashing(filePath: string): AsyncIterable<Uint8Array> {
    for await (const chunk of createReadStream(filePath)) {
      yield chunk as Uint8Array;
    }
  }
}

class NodeDiskSpaceProbe implements DiskSpaceProbe {
  async freeBytes(forPath: string): Promise<number> {
    // statfs reports the volume backing the path; bavail is blocks available to an
    // unprivileged user, which is the number that actually matters here. Fall back to
    // the home volume if the target path's volume can't be statted yet (e.g. the
    // models directory hasn't been created).
    const stats = await fs.statfs(forPath).catch(() => fs.statfs(os.homedir()));
    return stats.bavail * stats.bsize;
  }
}

class NodeNetworkProbe implements NetworkProbe {
  async isOnline(): Promise<boolean> {
    // A DNS lookup of a well-known always-up host is a cheap connectivity check; it
    // fails fast when offline. We probe a stable public host rather than the model
    // CDN so the check reflects general reachability, not one host's uptime.
    try {
      await dns.lookup("apple.com");
      return true;
    } catch {
      return false;
    }
  }
}

/** Assembles the real gateway set for production use in the Electron main process. */
export function createNodeProvisioningGateways(): ProvisioningGateways {
  return {
    download: new NodeRangeDownloadGateway(),
    fileSystem: new NodeFileSystemGateway(),
    diskSpace: new NodeDiskSpaceProbe(),
    network: new NodeNetworkProbe(),
  };
}

/** Joins a models-directory base with a relative segment using the OS separator. */
export function resolveModelsDirectory(baseDirectory: string): string {
  return path.join(baseDirectory, "models");
}
