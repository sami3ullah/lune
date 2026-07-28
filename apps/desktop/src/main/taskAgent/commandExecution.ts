import type { ExecFileException } from "node:child_process";
import type { CommandExecutionResult } from "@lune/core";

// The pure mapping from Node's `execFile` callback outcome to the Core's
// {@link CommandExecutionResult} (M5-02). It's small but fiddly - a non-zero exit, a spawn
// failure (ENOENT), and a signal kill all arrive as an `error` with different fields - so
// it's isolated here and unit-tested, and the platform's `runShellCommand`/`runAppleScript`
// stay thin wrappers around the real spawn.

/**
 * Turns an `execFile` result into a {@link CommandExecutionResult}. Success (no error) is
 * exit code 0. A command that ran but failed carries a numeric `code` (its exit status);
 * a spawn failure (e.g. `ENOENT`, a string code) or a kill has no numeric status, so it maps
 * to exit code 1 with the error's message surfaced on stderr when the command printed none.
 */
export function toCommandExecutionResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): CommandExecutionResult {
  if (error === null) {
    return { stdout, stderr, exitCode: 0 };
  }
  const exitCode = typeof error.code === "number" ? error.code : 1;
  const stderrText = stderr.trim().length > 0 ? stderr : error.message;
  return { stdout, stderr: stderrText, exitCode };
}
