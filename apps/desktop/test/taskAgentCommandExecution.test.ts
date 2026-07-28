import { describe, expect, it } from "vitest";
import type { ExecFileException } from "node:child_process";

import { toCommandExecutionResult } from "../src/main/taskAgent/commandExecution";

// The execFile-outcome mapping behind the shell/AppleScript platform tools (M5-02).

describe("toCommandExecutionResult", () => {
  it("maps a clean run to exit code 0", () => {
    expect(toCommandExecutionResult(null, "hello\n", "")).toEqual({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("carries a command's own non-zero exit status and stderr", () => {
    const error = Object.assign(new Error("Command failed"), { code: 2 }) as ExecFileException;
    expect(toCommandExecutionResult(error, "", "ls: no such file")).toEqual({
      stdout: "",
      stderr: "ls: no such file",
      exitCode: 2,
    });
  });

  it("maps a spawn failure (string code) to exit 1, surfacing the message when stderr is empty", () => {
    const error = Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" }) as ExecFileException;
    const result = toCommandExecutionResult(error, "", "");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ENOENT");
  });
});
