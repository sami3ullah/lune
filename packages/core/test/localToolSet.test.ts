import { describe, expect, it } from "vitest";

import { createLocalToolSet } from "../src/taskAgent/localToolSet.js";
import type { LocalToolPlatform } from "../src/taskAgent/localToolPlatform.js";
import type { ToolConfirmGate, ToolConfirmRequest } from "../src/taskAgent/toolConfirm.js";
import type { TaskAgentTool, ToolExecutionContext } from "../src/taskAgent/toolTypes.js";

// The local tool set is where the safety classifier, the platform seam, and the Confirm
// Gate meet. These tests drive it with a fake platform (records the effect it was asked
// for) and a fake gate (scripted approve/decline), asserting the ticket's rules: a
// consequential call is gated and only runs when approved; an allowlisted / benign call
// runs untouched; a declined call does not touch the platform and reports back to the model.

/** Options tuning the fake platform's behaviour. */
interface FakePlatformOptions {
  /** What `resolveOutputTarget` reports for `exists` (an overwrite when true). */
  outputExists?: boolean;
  /** A canned shell result, to exercise the non-zero-exit path. */
  shellResult?: { stdout: string; stderr: string; exitCode: number };
}

/** A platform that records every call and returns canned results. */
function fakePlatform(options: FakePlatformOptions = {}): LocalToolPlatform & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async openUrl(url) {
      calls.push(`openUrl:${url}`);
    },
    async runAppleScript(script) {
      calls.push(`runAppleScript:${script}`);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async runShellCommand(command) {
      calls.push(`runShellCommand:${command}`);
      return options.shellResult ?? { stdout: "shell-out", stderr: "", exitCode: 0 };
    },
    async readTextFile(path) {
      calls.push(`readTextFile:${path}`);
      return "file-contents";
    },
    async resolveOutputTarget(filename) {
      calls.push(`resolveOutputTarget:${filename}`);
      return { path: `/Users/me/Documents/Lune/${filename}`, exists: options.outputExists ?? false };
    },
    async writeOutputFile(request) {
      calls.push(`writeOutputFile:${request.path}:${request.format}`);
      return { path: request.path };
    },
    async webSearch(query) {
      calls.push(`webSearch:${query}`);
      return "search-results";
    },
    async webFetch(url) {
      calls.push(`webFetch:${url}`);
      return "page-text";
    },
  };
}

/** A gate that records what it was asked and answers per the script. */
function fakeGate(approve: boolean): ToolConfirmGate & { requests: ToolConfirmRequest[] } {
  const requests: ToolConfirmRequest[] = [];
  const gate = (async (request: ToolConfirmRequest) => {
    requests.push(request);
    return approve;
  }) as ToolConfirmGate & { requests: ToolConfirmRequest[] };
  gate.requests = requests;
  return gate;
}

const CONTEXT: ToolExecutionContext = { sessionId: "s1", signal: new AbortController().signal };

function toolNamed(tools: TaskAgentTool[], name: string): TaskAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool named ${name}`);
  }
  return tool;
}

describe("createLocalToolSet - inventory", () => {
  it("registers the whole zero-integration local tool set with JSON-Schema params", () => {
    const tools = createLocalToolSet({ platform: fakePlatform(), confirm: fakeGate(true) });
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["open_url", "read_file", "run_applescript", "run_shell_command", "web_fetch", "web_search", "write_file"].sort(),
    );
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("createLocalToolSet - benign tools run without a prompt", () => {
  it("open_url opens the URL and never gates", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(true);
    const result = await toolNamed(createLocalToolSet({ platform, confirm: gate }), "open_url").execute(
      { url: "https://example.com" },
      CONTEXT,
    );
    expect(platform.calls).toEqual(["openUrl:https://example.com"]);
    expect(gate.requests).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("https://example.com");
  });

  it("read_file, web_search and web_fetch pass through to the platform without gating", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(true);
    const tools = createLocalToolSet({ platform, confirm: gate });
    await toolNamed(tools, "read_file").execute({ path: "/etc/hosts" }, CONTEXT);
    await toolNamed(tools, "web_search").execute({ query: "weather berlin" }, CONTEXT);
    await toolNamed(tools, "web_fetch").execute({ url: "https://example.com" }, CONTEXT);
    expect(platform.calls).toEqual([
      "readTextFile:/etc/hosts",
      "webSearch:weather berlin",
      "webFetch:https://example.com",
    ]);
    expect(gate.requests).toEqual([]);
  });

  it("plays music via an ordinary AppleScript without a prompt (acceptance #1)", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(true);
    const script = 'tell application "Spotify" to play track "spotify:track:x"';
    await toolNamed(createLocalToolSet({ platform, confirm: gate }), "run_applescript").execute(
      { script },
      CONTEXT,
    );
    expect(platform.calls).toEqual([`runAppleScript:${script}`]);
    expect(gate.requests).toEqual([]);
  });

  it("runs an allowlisted shell command without a prompt (acceptance #2)", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(true);
    const result = await toolNamed(createLocalToolSet({ platform, confirm: gate }), "run_shell_command").execute(
      { command: "ls -la" },
      CONTEXT,
    );
    expect(platform.calls).toEqual(["runShellCommand:ls -la"]);
    expect(gate.requests).toEqual([]);
    expect(result.output).toContain("shell-out");
  });
});

describe("createLocalToolSet - the Confirm Gate on consequential calls", () => {
  it("prompts before a destructive shell command and runs it once approved (acceptance #2)", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(true);
    await toolNamed(createLocalToolSet({ platform, confirm: gate }), "run_shell_command").execute(
      { command: "rm -rf ~/Documents" },
      CONTEXT,
    );
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0]).toMatchObject({
      toolName: "run_shell_command",
      consequence: { level: "consequential" },
    });
    expect(gate.requests[0]!.summary).toContain("rm -rf ~/Documents");
    expect(gate.requests[0]!.signal).toBe(CONTEXT.signal);
    expect(platform.calls).toEqual(["runShellCommand:rm -rf ~/Documents"]);
  });

  it("does NOT run a destructive shell command when the gate is declined", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(false);
    const result = await toolNamed(createLocalToolSet({ platform, confirm: gate }), "run_shell_command").execute(
      { command: "rm -rf ~/Documents" },
      CONTEXT,
    );
    expect(gate.requests).toHaveLength(1);
    expect(platform.calls).toEqual([]); // never touched the OS
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/declin|cancel/i);
  });

  it("gates an AppleScript that shells out", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(false);
    await toolNamed(createLocalToolSet({ platform, confirm: gate }), "run_applescript").execute(
      { script: 'do shell script "rm -rf ~"' },
      CONTEXT,
    );
    expect(gate.requests).toHaveLength(1);
    expect(platform.calls).toEqual([]);
  });

  it("writes a new file without a prompt but gates an overwrite", async () => {
    // New file: benign, no prompt.
    const fresh = fakePlatform();
    const freshGate = fakeGate(true);
    const okResult = await toolNamed(createLocalToolSet({ platform: fresh, confirm: freshGate }), "write_file").execute(
      { filename: "note.md", format: "markdown", content: "# hi" },
      CONTEXT,
    );
    expect(freshGate.requests).toEqual([]);
    expect(fresh.calls).toEqual([
      "resolveOutputTarget:note.md",
      "writeOutputFile:/Users/me/Documents/Lune/note.md:markdown",
    ]);
    expect(okResult.output).toContain("/Users/me/Documents/Lune/note.md");

    // Existing file: consequential, prompts; declined => not written.
    const existing = fakePlatform({ outputExists: true });
    const declineGate = fakeGate(false);
    const declined = await toolNamed(
      createLocalToolSet({ platform: existing, confirm: declineGate }),
      "write_file",
    ).execute({ filename: "note.md", content: "overwrite me" }, CONTEXT);
    expect(declineGate.requests).toHaveLength(1);
    expect(existing.calls).toEqual(["resolveOutputTarget:note.md"]); // resolved, but never written
    expect(declined.isError).toBe(true);
  });
});

describe("createLocalToolSet - argument validation and platform errors", () => {
  it("reports a missing required argument as a recoverable error the model can fix", async () => {
    const platform = fakePlatform();
    const result = await toolNamed(createLocalToolSet({ platform, confirm: fakeGate(true) }), "open_url").execute(
      {},
      CONTEXT,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/url/i);
    expect(platform.calls).toEqual([]);
  });

  it("surfaces a non-zero shell exit as a recoverable error carrying stderr", async () => {
    const platform = fakePlatform({ shellResult: { stdout: "", stderr: "ls: no such file", exitCode: 2 } });
    const result = await toolNamed(
      createLocalToolSet({ platform, confirm: fakeGate(true) }),
      "run_shell_command",
    ).execute({ command: "ls /nope" }, CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("ls: no such file");
  });

  it("honours a caller-supplied shell allowlist", async () => {
    const platform = fakePlatform();
    const gate = fakeGate(true);
    await toolNamed(
      createLocalToolSet({ platform, confirm: gate, safeShellCommands: ["brew"] }),
      "run_shell_command",
    ).execute({ command: "brew list" }, CONTEXT);
    expect(gate.requests).toEqual([]); // brew is allowlisted here, so no prompt
    expect(platform.calls).toEqual(["runShellCommand:brew list"]);
  });
});
