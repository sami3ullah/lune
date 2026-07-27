import { execFileSync } from "node:child_process";

/**
 * Startup reaping of orphaned whisper-server processes. The normal teardown paths
 * (`before-quit` SIGTERM, `process.on("exit")` SIGKILL, and the signal handlers in
 * `index.ts`) cover every death the main process can *observe* - but a parent SIGKILL
 * or a hard crash runs no handler at all, so the whisper-server child is reparented to
 * launchd (PPID 1) and lingers forever, holding the model in memory. Nothing in-process
 * can intercept its own SIGKILL, so the only robust recovery is to reap those orphans on
 * the *next* launch, before we spawn a fresh child.
 *
 * We identify "our" orphans by the exact whisper-server binary path we are about to run:
 * every instance this app spawns shares that absolute path, and matching on it never
 * touches an unrelated app's whisper-server (a different bundle, a different path). The
 * pure selection logic is unit-tested; the impure `ps`/kill edge below stays thin and
 * untested, matching `nodeWhisperRuntime.ts`.
 */

/** One parsed `ps` row: a process id and its full command line (binary + args). */
export interface ProcessRow {
  pid: number;
  command: string;
}

/**
 * Parses `ps -A -o pid=,command=` output into rows. Each line is leading whitespace,
 * the pid, whitespace, then the full command; malformed lines are skipped rather than
 * throwing, so a single odd row never aborts the reap.
 */
export function parseProcessRows(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(rawLine);
    if (match === null) {
      continue;
    }
    rows.push({ pid: Number(match[1]), command: match[2] });
  }
  return rows;
}

/**
 * Selects the pids of whisper-server processes launched from `serverBinaryPath` - our
 * orphans from a prior run that died without teardown. A command matches when it is the
 * binary alone or the binary followed by its args (a space boundary), so a longer path
 * that merely *starts* with ours (`/foo/whisper-server-old`) is never caught. `ownPids`
 * is excluded defensively so the reaper can never target the live main process or a
 * child it is currently supervising.
 */
export function selectWhisperOrphanPids(input: {
  rows: readonly ProcessRow[];
  serverBinaryPath: string;
  ownPids?: readonly number[];
}): number[] {
  const exclude = new Set(input.ownPids ?? []);
  const binary = input.serverBinaryPath;
  return input.rows
    .filter((row) => !exclude.has(row.pid))
    .filter((row) => row.command === binary || row.command.startsWith(`${binary} `))
    .map((row) => row.pid);
}

/**
 * Best-effort: SIGKILL any orphaned whisper-server left by a prior run of *this* binary,
 * synchronously, before the caller spawns a fresh child. Every failure is swallowed and
 * logged - reaping is a cleanup nicety, never a startup blocker, so a missing `ps`, an
 * already-dead pid, or a permission error must not stop the app from launching.
 *
 * @returns the pids actually signalled (for logging/tests).
 */
export function reapOrphanedWhisperServers(serverBinaryPath: string): number[] {
  let psOutput: string;
  try {
    psOutput = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  } catch (error) {
    console.error("[runtime:whisper] could not list processes to reap orphans:", error);
    return [];
  }

  const orphanPids = selectWhisperOrphanPids({
    rows: parseProcessRows(psOutput),
    serverBinaryPath,
    ownPids: [process.pid],
  });

  const killedPids: number[] = [];
  for (const pid of orphanPids) {
    try {
      process.kill(pid, "SIGKILL");
      killedPids.push(pid);
    } catch (error) {
      // ESRCH just means it exited between listing and killing - nothing to do.
      const isGone = (error as NodeJS.ErrnoException).code === "ESRCH";
      if (!isGone) {
        console.error(`[runtime:whisper] failed to reap orphaned whisper-server pid ${pid}:`, error);
      }
    }
  }
  if (killedPids.length > 0) {
    console.log(`[runtime:whisper] reaped ${killedPids.length} orphaned whisper-server process(es):`, killedPids);
  }
  return killedPids;
}
