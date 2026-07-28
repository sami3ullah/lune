/**
 * The local-tool platform seam (M5-02): the single injected boundary through which the
 * local tool set reaches the OS and the network, so the Core stays pure and
 * transport-agnostic (developer story 45; the Core imports no Electron and no HTTP).
 *
 * Every real effect a Task Agent's local tools have - opening a URL, running an
 * AppleScript, spawning a shell command, reading/writing files, searching and fetching the
 * web - lands on one of these methods. The Electron main process fills them with
 * Node/Electron implementations (`shell.openExternal`, `osascript`, `child_process`, `fs`,
 * a hidden-window `printToPDF`, `fetch`); a test fills them with fakes. The tool set
 * ({@link import("./localToolSet.js")}) holds the schemas, the safety classification, and
 * the Confirm-Gate wiring; this holds nothing but the effects.
 *
 * AppleScript is macOS-specific and sits behind this interface on purpose - the PowerShell
 * equivalent is M7, a different platform implementation of the same seam, with the tool set
 * and its safety rules unchanged.
 */

/**
 * The output formats {@link LocalToolPlatform.writeOutputFile} can produce. `csv` is the
 * spreadsheet format - it opens directly in Excel/Numbers and needs no third-party encoder,
 * so it covers the epic's "create an Excel file" with zero dependencies; a native `.xlsx`
 * writer, if ever wanted, is an additive format here, not a change to this seam.
 */
export type OutputFileFormat = "text" | "markdown" | "pdf" | "csv";

/** The result of running a shell command (or AppleScript, which shares the shape). */
export interface CommandExecutionResult {
  /** The command's standard output. */
  stdout: string;
  /** The command's standard error (may be empty). */
  stderr: string;
  /** The process exit code; `0` is success. A non-zero code is a recoverable tool error. */
  exitCode: number;
}

/** Where a named output file resolves to, and whether something is already there. */
export interface ResolvedOutputTarget {
  /** The absolute path the file will be written to (in the predictable output location). */
  path: string;
  /** Whether a file already exists at `path` - the signal the overwrite classification needs. */
  exists: boolean;
}

/** A file to write into the predictable, user-visible output location. */
export interface WriteOutputFileRequest {
  /** The absolute path resolved by {@link LocalToolPlatform.resolveOutputTarget}. */
  path: string;
  /** The output format; the platform encodes `content` accordingly (e.g. renders a PDF). */
  format: OutputFileFormat;
  /**
   * The file's content as text: the note body, the markdown/PDF source, or the raw CSV.
   * The platform is responsible for turning it into the on-disk representation of `format`.
   */
  content: string;
}

/** The OS/network effects the local tool set is composed over; injected, never imported. */
export interface LocalToolPlatform {
  /** Opens a URL in the user's default browser (or the default app for its scheme). */
  openUrl(url: string): Promise<void>;
  /**
   * Runs an AppleScript and returns its result. Rejects only on an inability to run the
   * script engine at all; a script that runs but reports an error returns a non-zero
   * `exitCode` with the reason on `stderr` (a recoverable tool error).
   */
  runAppleScript(script: string, signal?: AbortSignal): Promise<CommandExecutionResult>;
  /**
   * Runs a shell command. Called only after the Confirm Gate has approved a consequential
   * command (or for an allowlisted one); the platform does not itself gate. Honours the
   * signal so a Session cancel kills a long-running command.
   */
  runShellCommand(command: string, signal?: AbortSignal): Promise<CommandExecutionResult>;
  /** Reads a UTF-8 text file and returns its contents. Rejects if the file can't be read. */
  readTextFile(path: string): Promise<string>;
  /**
   * Resolves a caller-chosen filename (for the given format) to the final absolute path in
   * the predictable output location - sanitising the name and normalising its extension -
   * and reports whether a file is already there, so the tool set can classify an overwrite
   * before writing. Does not create anything. The returned `path` is exactly what a
   * subsequent {@link writeOutputFile} will write to.
   */
  resolveOutputTarget(filename: string, format: OutputFileFormat): Promise<ResolvedOutputTarget>;
  /** Writes (or overwrites) an output file and returns the absolute path it landed at. */
  writeOutputFile(request: WriteOutputFileRequest): Promise<{ path: string }>;
  /** Runs a web search and returns a readable, model-friendly summary of the results. */
  webSearch(query: string, signal?: AbortSignal): Promise<string>;
  /** Fetches a web page and returns its readable text content. */
  webFetch(url: string, signal?: AbortSignal): Promise<string>;
}
