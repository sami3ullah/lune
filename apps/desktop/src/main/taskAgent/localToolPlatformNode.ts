import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import type {
  CommandExecutionResult,
  LocalToolPlatform,
  OutputFileFormat,
  ResolvedOutputTarget,
  WriteOutputFileRequest,
} from "@lune/core";
import { toCommandExecutionResult } from "./commandExecution";
import { buildPdfHtml, ensureExtension, sanitizeOutputFilename } from "./outputFiles";
import {
  DEFAULT_SEARCH_RESULT_COUNT,
  formatSearchResults,
  htmlToReadableText,
  parseDuckDuckGoResults,
} from "./webContent";

// The Node/Electron implementation of the Core's local-tool platform seam (M5-02): the one
// place a Task Agent's local tools actually touch the OS and the network. The Core holds the
// tool schemas, the safety classification, and the Confirm-Gate wiring; this holds only the
// effects - `shell.openExternal`, `osascript`, the login shell, `fs`, a hidden-window
// `printToPDF`, and the global `fetch`.
//
// Every command runner *resolves* with a result (never rejects for a command-level failure),
// so a non-zero exit becomes a recoverable tool error the model can react to rather than a
// crashed Session. A long-running command honours the Session's abort signal, so a cancel
// kills it. AppleScript is macOS-specific and lives here on purpose; the PowerShell
// equivalent (M7) is a different implementation of this same seam.

/** A wall-clock cap on a single command/AppleScript run, so a hung command can't wedge a Session. */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** A cap on a command's captured output, matching the AX reader's bound. */
const COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** The DuckDuckGo keyless HTML search endpoint (no API key, zero integrations). */
const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

/** A browser-like User-Agent so the web endpoints return their normal HTML. */
const FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lune/1.0";

/** Options for {@link createNodeLocalToolPlatform}. */
export interface NodeLocalToolPlatformOptions {
  /**
   * The predictable, user-visible folder output files land in (acceptance #3) - e.g.
   * `~/Documents/Lune`. Created on first write.
   */
  outputDirectory: string;
  /** The login shell used to run shell commands (so the user's PATH is available). */
  shellPath?: string;
  /** The per-command wall-clock timeout; defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number;
}

/** Runs a program via `execFile`, resolving a {@link CommandExecutionResult} (never rejecting). */
function runExecFile(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: COMMAND_MAX_BUFFER_BYTES, killSignal: "SIGKILL", signal },
      (error, stdout, stderr) => {
        resolve(toCommandExecutionResult(error, stdout, stderr));
      },
    );
  });
}

/**
 * Renders static HTML to a PDF buffer using an offscreen, JS-disabled window. JS is off and
 * the content is loaded as a `data:` URL, so the note's HTML can't execute or fetch anything;
 * it is purely laid out and printed.
 */
async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, javascript: false },
  });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await window.webContents.printToPDF({ printBackground: true });
  } finally {
    window.destroy();
  }
}

/**
 * Builds the Node/Electron {@link LocalToolPlatform}. Injected into
 * {@link import("@lune/core").createLocalToolSet}; the resulting tools are registered with
 * the Task Agent runtime.
 */
export function createNodeLocalToolPlatform(
  options: NodeLocalToolPlatformOptions,
): LocalToolPlatform {
  const { outputDirectory } = options;
  const shellPath = options.shellPath ?? process.env.SHELL ?? "/bin/zsh";
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  async function resolveOutputTarget(
    filename: string,
    format: OutputFileFormat,
  ): Promise<ResolvedOutputTarget> {
    const safeName = ensureExtension(sanitizeOutputFilename(filename), format);
    const path = join(outputDirectory, safeName);
    let exists = true;
    try {
      await access(path);
    } catch {
      exists = false;
    }
    return { path, exists };
  }

  async function writeOutputFile(request: WriteOutputFileRequest): Promise<{ path: string }> {
    await mkdir(outputDirectory, { recursive: true });
    if (request.format === "pdf") {
      const pdf = await renderHtmlToPdf(buildPdfHtml(request.content));
      await writeFile(request.path, pdf);
    } else {
      // text / markdown / csv are all UTF-8 text on disk; the model supplies the exact bytes.
      await writeFile(request.path, request.content, "utf8");
    }
    return { path: request.path };
  }

  return {
    async openUrl(url) {
      await shell.openExternal(url);
    },
    runAppleScript(script, signal) {
      return runExecFile("osascript", ["-e", script], commandTimeoutMs, signal);
    },
    runShellCommand(command, signal) {
      // `-l` loads the login profile so the user's PATH is present; `-c` runs the command
      // (letting the model's approved pipelines/redirections work as written).
      return runExecFile(shellPath, ["-lc", command], commandTimeoutMs, signal);
    },
    async readTextFile(path) {
      return readFile(path, "utf8");
    },
    resolveOutputTarget,
    writeOutputFile,
    async webSearch(query, signal) {
      const url = `${DUCKDUCKGO_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { "User-Agent": FETCH_USER_AGENT }, signal });
      if (!response.ok) {
        throw new Error(`Web search failed: HTTP ${response.status}`);
      }
      const html = await response.text();
      return formatSearchResults(query, parseDuckDuckGoResults(html), DEFAULT_SEARCH_RESULT_COUNT);
    },
    async webFetch(url, signal) {
      const response = await fetch(url, { headers: { "User-Agent": FETCH_USER_AGENT }, signal });
      if (!response.ok) {
        throw new Error(`Fetch failed: HTTP ${response.status}`);
      }
      const html = await response.text();
      return htmlToReadableText(html);
    },
  };
}
