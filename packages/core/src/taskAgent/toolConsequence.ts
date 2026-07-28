/**
 * The Task Agent tool-safety classifier (M5-02): the pure rules that decide whether a
 * local tool call is `benign` or `consequential`, reusing the Screen Agent's Consequence
 * Level vocabulary (DECISIONS #15). A `consequential` call trips the Confirm Gate before
 * it runs; a `benign` call runs without nagging.
 *
 * This is the safety-critical core of the ticket, so it is a pure function of its inputs -
 * no OS, no I/O - and unit-tested exhaustively. The actual gate UX (speaking the line,
 * listening for approve/cancel) is the Shell's, injected behind the {@link import("./toolConfirm.js").ToolConfirmGate}
 * seam; this module only decides *whether* to gate and supplies the human reason the gate
 * speaks.
 *
 * Unlike the Screen Agent's escalate-only floor (which starts from the model's tag and can
 * only raise it), these rules start from the safe assumption and *earn* `benign`: a shell
 * command is consequential unless it is a known read-only program with no shell escape, and
 * a file write is consequential when it would overwrite. That direction matters - the wrong
 * default here runs `rm -rf` without asking, so the default is "ask".
 */
import type { ConsequenceLevel } from "../agent/agentAction.js";

export type { ConsequenceLevel };

/** A classification verdict: the level plus a human reason for the gate's spoken line. */
export interface ToolConsequence {
  level: ConsequenceLevel;
  /** Why the call was classified this way (e.g. "runs the non-allowlisted command 'rm'"). */
  reason: string;
}

/**
 * The default allowlist of shell programs safe to run without a prompt: each is read-only or
 * purely informational, so running it (with plain arguments and no shell escape) cannot
 * destroy, overwrite, or exfiltrate anything. Deliberately conservative, and it excludes two
 * classes even when they might look harmless, because they defeat the allowlist without any
 * shell metacharacter:
 *
 *   - *command runners* that execute another program named in their arguments - `env`,
 *     `xargs`, `nice`, `timeout`, `sudo`, `watch` - since `env rm -rf ~` would otherwise run
 *     `rm` unprompted;
 *   - *tools with an output-file flag* that write an arbitrary path - `sort -o`, `uniq out`,
 *     `tee`, `dd`, `cp` - since a write is a destructive file operation.
 *
 * A program that can delete (`rm`), overwrite, or execute fetched code is likewise absent.
 * Matched by basename, case-sensitively (Unix program names are lowercase).
 */
export const DEFAULT_SAFE_SHELL_COMMANDS: readonly string[] = [
  "ls", "pwd", "echo", "cat", "head", "tail", "wc", "date", "whoami", "id",
  "hostname", "uname", "uptime", "df", "du", "which", "type", "printenv",
  "ps", "file", "stat", "sw_vers", "arch",
];

/**
 * Shell metacharacters that let a command chain, redirect, or substitute - i.e. do more
 * than run one allowlisted program with literal arguments. Their presence forces
 * `consequential` even for an allowlisted program, because `echo x > /etc/hosts` or
 * `ls && rm -rf /` is no longer the safe command the allowlist vouched for.
 */
const SHELL_ESCAPE_PATTERN = /[;&|<>`$()]|\n/;

/** Options for {@link classifyShellCommand}. */
export interface ClassifyShellCommandOptions {
  /** The allowlist of safe program basenames; defaults to {@link DEFAULT_SAFE_SHELL_COMMANDS}. */
  safeCommands?: readonly string[];
}

/**
 * Classifies a shell command. Benign only when its leading program is on the allowlist and
 * the whole command carries no shell escape (chaining / redirection / substitution);
 * everything else - a non-allowlisted program, a pipeline, a blank command - is
 * consequential and prompts. This backs the acceptance criterion "a destructive shell
 * command prompts before running; allowlisted commands don't".
 */
export function classifyShellCommand(
  command: string,
  options: ClassifyShellCommandOptions = {},
): ToolConsequence {
  const safeCommands = options.safeCommands ?? DEFAULT_SAFE_SHELL_COMMANDS;
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { level: "consequential", reason: "runs an empty shell command" };
  }
  if (SHELL_ESCAPE_PATTERN.test(trimmed)) {
    return {
      level: "consequential",
      reason: "runs a shell command that chains, redirects, or substitutes",
    };
  }
  const program = basename(firstToken(trimmed));
  if (safeCommands.includes(program)) {
    return { level: "benign", reason: `runs the read-only command '${program}'` };
  }
  return { level: "consequential", reason: `runs the non-allowlisted command '${program}'` };
}

/** The current state of a file-write target, as reported by the platform. */
export interface FileWriteTarget {
  /** Whether a file already exists at the resolved path (an overwrite is destructive). */
  exists: boolean;
}

/**
 * Classifies a file write. Creating a new file is benign; overwriting an existing one is a
 * destructive file operation and prompts. (Both write into the predictable, user-visible
 * output location; the platform resolves the path and reports whether it already exists.)
 */
export function classifyFileWrite(target: FileWriteTarget): ToolConsequence {
  return target.exists
    ? { level: "consequential", reason: "overwrites a file that already exists" }
    : { level: "benign", reason: "writes a new file" };
}

/**
 * Substrings that make an AppleScript consequential. AppleScript is ordinary app
 * automation - "play X on Spotify" must run without friction (acceptance #1) - so it is
 * benign by default; but a script that shells out (`do shell script`, a full shell escape)
 * or destroys data (delete / erase / empty the trash) is as dangerous as the shell path
 * and prompts. Case-insensitive substrings, over-inclusive on purpose.
 */
const CONSEQUENTIAL_APPLESCRIPT_KEYWORDS: readonly string[] = [
  "do shell script", "delete", "erase", "empty the trash", "move to trash",
];

/**
 * Classifies an AppleScript. Benign by default (app automation); consequential when it
 * shells out or destroys data. AppleScript sits behind the platform interface (the
 * PowerShell equivalent is M7); this classification is platform-independent.
 */
export function classifyAppleScript(script: string): ToolConsequence {
  const normalized = script.toLowerCase();
  const matched = CONSEQUENTIAL_APPLESCRIPT_KEYWORDS.find((keyword) => normalized.includes(keyword));
  if (matched !== undefined) {
    return { level: "consequential", reason: `runs an AppleScript that '${matched}'` };
  }
  return { level: "benign", reason: "runs an app-automation AppleScript" };
}

/** The first whitespace-delimited token of a command (its program, before arguments). */
function firstToken(command: string): string {
  const match = command.match(/^\S+/);
  return match ? match[0] : command;
}

/** The basename of a path-or-program token, so `/bin/ls` classifies as `ls`. */
function basename(token: string): string {
  const lastSlash = token.lastIndexOf("/");
  return lastSlash === -1 ? token : token.slice(lastSlash + 1);
}
