import { parsePillAnchor, type PillAnchor } from "./pillGeometry";

/** Reads the persisted position file's raw contents, or throws if it is absent. */
export type ReadPositionFile = (filePath: string) => string;

/** Writes the persisted position file's contents (best-effort). */
export type WritePositionFile = (filePath: string, contents: string) => void;

/**
 * Persists the Pill's anchor so its position survives restarts (ticket 04). The
 * filesystem is injected rather than imported so the store is a thin, testable
 * seam over pure JSON <-> {@link PillAnchor} coding; the main process supplies the
 * real `fs` reader/writer and the userData path.
 */
export class PillPositionStore {
  constructor(
    private readonly filePath: string,
    private readonly readFile: ReadPositionFile,
    private readonly writeFile: WritePositionFile,
  ) {}

  /**
   * The last saved anchor, or `null` when none is stored yet or the file is
   * unreadable/corrupt - in which case the caller falls back to the default
   * position rather than a garbage coordinate.
   */
  load(): PillAnchor | null {
    let raw: string;
    try {
      raw = this.readFile(this.filePath);
    } catch {
      // No file yet (first run) or an unreadable one - treat as "no saved position".
      return null;
    }
    try {
      return parsePillAnchor(JSON.parse(raw));
    } catch {
      // Not JSON at all - a truncated or hand-mangled file. Fall back to default.
      return null;
    }
  }

  /**
   * Persists `anchor`. Failure to write (read-only disk, permissions) is swallowed:
   * a lost position on the next launch is a minor annoyance, never worth crashing
   * the app the user is mid-conversation with.
   */
  save(anchor: PillAnchor): void {
    try {
      this.writeFile(this.filePath, JSON.stringify(anchor));
    } catch (error) {
      console.error("[lune] could not persist pill position:", error);
    }
  }
}
