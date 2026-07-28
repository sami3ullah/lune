/**
 * The local tool set (M5-02): the tools that make a Task Agent useful with zero
 * integrations - open a URL, run an AppleScript, run a shell command, read and write files
 * (a note, a PDF, a CSV), and search/fetch the web.
 *
 * This module is where the three M5-02 parts compose: it declares each tool's schema
 * (name/description/JSON-Schema params) for the model, classifies the dangerous ones
 * through the pure safety classifier ({@link import("./toolConsequence.js")}), interposes
 * the injected Confirm Gate ({@link import("./toolConfirm.js").ToolConfirmGate}) before a
 * consequential effect, and runs the effect through the injected platform seam
 * ({@link import("./localToolPlatform.js").LocalToolPlatform}). It stays true to the Core's
 * boundary - no OS, no HTTP; every real effect is the platform's, every user question is
 * the gate's. The runtime (M5-01) is unchanged and never learns any of this: it just calls
 * `execute` on the tools in the registry.
 *
 * A tool's `execute` never throws for an expected condition - a bad argument, a declined
 * gate, a non-zero command exit - because those are *recoverable* outcomes the model should
 * see and adapt to (the runtime feeds an `isError` result back into the conversation). It
 * throws only for the genuinely unexpected, which the runtime turns into the same
 * recoverable result anyway.
 */
import {
  classifyAppleScript,
  classifyFileWrite,
  classifyShellCommand,
} from "./toolConsequence.js";
import type { ToolConsequence } from "./toolConsequence.js";
import type {
  CommandExecutionResult,
  LocalToolPlatform,
  OutputFileFormat,
} from "./localToolPlatform.js";
import type { ToolConfirmGate } from "./toolConfirm.js";
import type {
  TaskAgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./toolTypes.js";

/** The dependencies the local tool set is built from. */
export interface LocalToolSetDependencies {
  /** The OS/network effects boundary (Node/Electron in production, a fake in tests). */
  platform: LocalToolPlatform;
  /**
   * The Confirm Gate a consequential call must pass. Required (not defaulted) on purpose:
   * the whole point of M5-02 is that a destructive action is never silently run, so a tool
   * set with no gate is a wiring mistake, not a convenience default.
   */
  confirm: ToolConfirmGate;
  /**
   * The allowlist of shell program basenames that run without a prompt; defaults to
   * {@link import("./toolConsequence.js").DEFAULT_SAFE_SHELL_COMMANDS}.
   */
  safeShellCommands?: readonly string[];
}

/** The output formats `write_file` accepts, mirroring the platform's. */
const OUTPUT_FILE_FORMATS: readonly OutputFileFormat[] = ["text", "markdown", "pdf", "csv"];

/**
 * Builds the local tool set. Returns the tools as a plain array; the caller registers them
 * with {@link import("./toolRegistry.js").createToolRegistry} and hands the registry to the
 * Task Agent runtime.
 */
export function createLocalToolSet(dependencies: LocalToolSetDependencies): TaskAgentTool[] {
  const { platform, confirm, safeShellCommands } = dependencies;

  /**
   * Passes a consequential call through the gate; a benign call skips it. Returns `true`
   * when the effect may proceed. The gate is handed the Session's cancellation signal so a
   * Barge-in / dismiss resolves it `false` without waiting.
   */
  async function approved(
    toolName: string,
    summary: string,
    consequence: ToolConsequence,
    context: ToolExecutionContext,
  ): Promise<boolean> {
    if (consequence.level === "benign") {
      return true;
    }
    return confirm({ toolName, summary, consequence, signal: context.signal });
  }

  const openUrl: TaskAgentTool = {
    name: "open_url",
    description:
      "Open a URL in the user's default web browser. Use this to show the user a web page " +
      "or web app. Benign - it never runs without asking only because it opens something visible.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The absolute URL to open, e.g. https://example.com" } },
      required: ["url"],
    },
    async execute(input, _context) {
      const url = stringArgument(input, "url");
      if (url === null) {
        return missingArgument("url");
      }
      await platform.openUrl(url);
      return { output: `Opened ${url} in the browser.`, artifact: { kind: "url", url } };
    },
  };

  const runAppleScript: TaskAgentTool = {
    name: "run_applescript",
    description:
      "Run an AppleScript on macOS to automate an app - e.g. play a track in Spotify, " +
      "create a reminder, control the Music app. Ordinary app automation runs immediately; " +
      "a script that shells out or deletes data asks the user first.",
    parameters: {
      type: "object",
      properties: { script: { type: "string", description: "The AppleScript source to run." } },
      required: ["script"],
    },
    async execute(input, context) {
      const script = stringArgument(input, "script");
      if (script === null) {
        return missingArgument("script");
      }
      const consequence = classifyAppleScript(script);
      if (!(await approved("run_applescript", `run an AppleScript that ${consequence.reason}`, consequence, context))) {
        return declined("running the AppleScript");
      }
      const result = await platform.runAppleScript(script, context.signal);
      return commandResult(result, "The AppleScript ran successfully.");
    },
  };

  const runShellCommand: TaskAgentTool = {
    name: "run_shell_command",
    description:
      "Run a shell command and return its output. Read-only, allowlisted commands (ls, cat, " +
      "echo, date, ...) run immediately; anything else - or any command that chains, " +
      "redirects, or deletes - asks the user before running.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command line to run." } },
      required: ["command"],
    },
    async execute(input, context) {
      const command = stringArgument(input, "command");
      if (command === null) {
        return missingArgument("command");
      }
      const consequence = classifyShellCommand(command, { safeCommands: safeShellCommands });
      if (!(await approved("run_shell_command", `run the command: ${command}`, consequence, context))) {
        return declined("running the command");
      }
      const result = await platform.runShellCommand(command, context.signal);
      return commandResult(result, "The command ran successfully with no output.");
    },
  };

  const readFile: TaskAgentTool = {
    name: "read_file",
    description: "Read a UTF-8 text file from disk and return its contents. Read-only.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The absolute path of the file to read." } },
      required: ["path"],
    },
    async execute(input, _context) {
      const path = stringArgument(input, "path");
      if (path === null) {
        return missingArgument("path");
      }
      const contents = await platform.readTextFile(path);
      return { output: contents };
    },
  };

  const writeFile: TaskAgentTool = {
    name: "write_file",
    description:
      "Write a file for the user - a note, a PDF, or a CSV/spreadsheet - into the user's " +
      "Lune output folder (a predictable, visible location). Creating a new file is " +
      "immediate; overwriting an existing one asks first. Returns where the file was saved. " +
      "For any list or table of data, save a CSV by default (it opens as a spreadsheet) unless " +
      "the user explicitly asked for another format.",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description:
            "The file name to save under, including an extension that matches the format, e.g. " +
            "'creators.csv' for a list or 'notes.md' for a note.",
        },
        format: {
          type: "string",
          enum: [...OUTPUT_FILE_FORMATS],
          description:
            "How to encode the content. Defaults to 'text'. For a list or any table of data use " +
            "'csv' - that is the default for lists unless the user asked for something else; use " +
            "'pdf' for documents and 'markdown' for a formatted note.",
        },
        content: {
          type: "string",
          description: "The file's content: the note/PDF body (plain text or markdown), or raw CSV rows.",
        },
      },
      required: ["filename", "content"],
    },
    async execute(input, context) {
      const filename = stringArgument(input, "filename");
      if (filename === null) {
        return missingArgument("filename");
      }
      const content = input.content;
      if (typeof content !== "string") {
        return missingArgument("content");
      }
      const format = resolveFormat(input.format);
      if (format === null) {
        return { output: `Unsupported format; choose one of: ${OUTPUT_FILE_FORMATS.join(", ")}.`, isError: true };
      }

      const target = await platform.resolveOutputTarget(filename, format);
      const consequence = classifyFileWrite({ exists: target.exists });
      if (!(await approved("write_file", `overwrite the file ${filename}`, consequence, context))) {
        return declined(`writing ${filename}`);
      }
      const written = await platform.writeOutputFile({ path: target.path, format, content });
      return { output: `Saved to ${written.path}.`, artifact: { kind: "file", path: written.path } };
    },
  };

  const webSearch: TaskAgentTool = {
    name: "web_search",
    description: "Search the web and return a readable summary of the top results. Read-only.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
    },
    async execute(input, context) {
      const query = stringArgument(input, "query");
      if (query === null) {
        return missingArgument("query");
      }
      const results = await platform.webSearch(query, context.signal);
      return { output: results };
    },
  };

  const webFetch: TaskAgentTool = {
    name: "web_fetch",
    description: "Fetch a web page and return its readable text content. Read-only.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The absolute URL of the page to fetch." } },
      required: ["url"],
    },
    async execute(input, context) {
      const url = stringArgument(input, "url");
      if (url === null) {
        return missingArgument("url");
      }
      const text = await platform.webFetch(url, context.signal);
      return { output: text };
    },
  };

  return [openUrl, runAppleScript, runShellCommand, readFile, writeFile, webSearch, webFetch];
}

/** Reads a required string argument, returning `null` when absent or blank. */
function stringArgument(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The recoverable result for a missing/blank required argument. */
function missingArgument(field: string): ToolExecutionResult {
  return { output: `The '${field}' argument is required and must be a non-empty string.`, isError: true };
}

/** The recoverable result when the user declines a consequential action at the Confirm Gate. */
function declined(action: string): ToolExecutionResult {
  return { output: `The user declined ${action}.`, isError: true };
}

/** Resolves the optional `format` argument to a known format, `"text"` when absent, `null` when invalid. */
function resolveFormat(value: unknown): OutputFileFormat | null {
  if (value === undefined) {
    return "text";
  }
  return typeof value === "string" && (OUTPUT_FILE_FORMATS as readonly string[]).includes(value)
    ? (value as OutputFileFormat)
    : null;
}

/**
 * Turns a command/AppleScript result into a tool result: its stdout on success, or a
 * recoverable error carrying the exit code and stderr the model can react to.
 */
function commandResult(
  result: CommandExecutionResult,
  emptySuccessMessage: string,
): ToolExecutionResult {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().length > 0 ? result.stderr.trim() : result.stdout.trim();
    return { output: `Exited with code ${result.exitCode}: ${detail}`, isError: true };
  }
  const output = result.stdout.trim();
  return { output: output.length > 0 ? output : emptySuccessMessage };
}
