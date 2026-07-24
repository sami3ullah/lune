import { execFile } from "node:child_process";
import type { RawAxElement, RawAxSignal } from "./agentTargetSignal";

// The untested OS edge behind M2-05's AX target signal: reads the on-screen accessibility
// elements (focused element + the actionable elements' frames) that let the Consequence
// floor's click-hit-test escalation fire. It is the accessibility sibling of the synthetic
// input backend and the push-to-talk hook - a thin, best-effort OS read behind an interface,
// so the pure transform above it (`agentTargetSignal`) is what the tests drive.
//
// v1 read this in Swift (`AXUIElementCopyElementAtPosition`, exact and O(1)); Lune is
// Electron/TS with no native AX addon, so the macOS reader shells out to `osascript` (JXA)
// over the same System Events accessibility API the app is already granted. That read is
// deliberately BEST-EFFORT: a bounded breadth-first walk of the frontmost app's windows
// (node + element caps) under a hard wall-clock timeout, and *any* failure - no
// accessibility, a slow or huge tree, a timeout, a parse error - resolves to `null` so the
// Core simply applies no floor escalation (the "degrade gracefully in apps with poor
// accessibility trees" contract, acceptance #3). Web content in a browser is the known weak
// spot; it degrades to no signal rather than a wrong one.
//
// The interface is also the seam a future native AX addon drops into without touching the
// pure pipeline or the floor - the same platform-interface discipline as the input backend.

/** Reads the accessibility target signal for the current scene, or `null` when unavailable. */
export interface AxSignalProvider {
  /**
   * Reads the on-screen accessibility signal in global-logical coordinates, or resolves
   * `null` when it cannot (no accessibility, a timeout, or an error). Never rejects, so the
   * scene capture can always attach "whatever was read, or nothing" without a try/catch.
   */
  capture(): Promise<RawAxSignal | null>;
}

/** How long the accessibility read may run before it is killed and degraded to `null`. */
const DEFAULT_AX_READ_TIMEOUT_MS = 1500;

/** Cap on the JXA output size; 400 small element records stay well under this. */
const AX_READ_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * The JXA (JavaScript-for-Automation) program run via `osascript`. It walks the frontmost
 * application's windows breadth-first, collecting the actionable elements' frames (in global
 * screen points, top-left origin) plus the focused element's role/title, and prints one JSON
 * object. It is intentionally bounded (a node cap and an element cap) and wrapped so any
 * internal failure yields `{}` rather than throwing - the caller's timeout is the hard stop.
 */
const AX_READ_JXA = `(function () {
  var ACTIONABLE = {
    AXButton: 1, AXLink: 1, AXMenuItem: 1, AXMenuButton: 1,
    AXPopUpButton: 1, AXCheckBox: 1, AXRadioButton: 1
  };
  var MAX_NODES = 1200;
  var MAX_ELEMENTS = 400;

  function safeRole(el) { try { return el.role(); } catch (e) { return null; } }
  function safeTitle(el) {
    var keys = ['title', 'description', 'value'];
    for (var i = 0; i < keys.length; i++) {
      try {
        var v = el[keys[i]]();
        if (typeof v === 'string' && v.length > 0) return v;
      } catch (e) {}
    }
    return null;
  }

  try {
    var se = Application('System Events');
    var procs = se.applicationProcesses.whose({ frontmost: true });
    if (!procs || procs.length === 0) return JSON.stringify({});
    var proc = procs[0];
    var result = { elements: [] };

    try {
      var focused = proc.attributes.byName('AXFocusedUIElement').value();
      if (focused) {
        result.focused = { role: safeRole(focused), title: safeTitle(focused) };
      }
    } catch (e) {}

    var queue = [];
    try {
      var windows = proc.windows();
      for (var w = 0; w < windows.length; w++) queue.push(windows[w]);
    } catch (e) {}

    var visited = 0;
    while (queue.length > 0 && visited < MAX_NODES && result.elements.length < MAX_ELEMENTS) {
      var node = queue.shift();
      visited++;
      var role = safeRole(node);
      if (role && ACTIONABLE[role]) {
        try {
          var pos = node.position();
          var size = node.size();
          if (pos && size) {
            result.elements.push({
              x: pos[0], y: pos[1], w: size[0], h: size[1],
              role: role, title: safeTitle(node)
            });
          }
        } catch (e) {}
      }
      try {
        var kids = node.uiElements();
        for (var k = 0; k < kids.length; k++) queue.push(kids[k]);
      } catch (e) {}
    }

    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({});
  }
})()`;

/** A finite number, or `undefined` when the value is not a usable coordinate. */
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parses the JXA reader's stdout into a {@link RawAxSignal}, or `null` when the output is
 * empty, unparseable, or carries nothing useful. Kept pure and exported so the JSON shape
 * (and its many partial/garbage cases) is unit-tested apart from the untested `osascript`
 * spawn. An element is kept only when it has a finite frame; its role/title are optional.
 */
export function parseAxSignalOutput(stdout: string): RawAxSignal | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const raw = parsed as { focused?: unknown; elements?: unknown };

  const signal: RawAxSignal = {};

  if (typeof raw.focused === "object" && raw.focused !== null) {
    const focused = raw.focused as { role?: unknown; title?: unknown };
    const focusedRole = nonEmptyString(focused.role);
    const focusedLabel = nonEmptyString(focused.title);
    if (focusedRole !== undefined) {
      signal.focusedRole = focusedRole;
    }
    if (focusedLabel !== undefined) {
      signal.focusedLabel = focusedLabel;
    }
  }

  if (Array.isArray(raw.elements)) {
    const elements: RawAxElement[] = [];
    for (const candidate of raw.elements) {
      if (typeof candidate !== "object" || candidate === null) {
        continue;
      }
      const record = candidate as Record<string, unknown>;
      const x = finiteOrUndefined(record.x);
      const y = finiteOrUndefined(record.y);
      const width = finiteOrUndefined(record.w);
      const height = finiteOrUndefined(record.h);
      if (x === undefined || y === undefined || width === undefined || height === undefined) {
        continue;
      }
      const element: RawAxElement = { x, y, width, height };
      const label = nonEmptyString(record.title);
      const role = nonEmptyString(record.role);
      if (label !== undefined) {
        element.label = label;
      }
      if (role !== undefined) {
        element.role = role;
      }
      elements.push(element);
    }
    if (elements.length > 0) {
      signal.elements = elements;
    }
  }

  const hasFocused = signal.focusedLabel !== undefined || signal.focusedRole !== undefined;
  if (!hasFocused && signal.elements === undefined) {
    return null;
  }
  return signal;
}

/** Options for {@link createMacAxSignalProvider} (injected in tests; defaulted in production). */
export interface MacAxSignalProviderOptions {
  /** Runs the JXA and resolves its stdout; defaults to spawning `osascript`. */
  runReader?: () => Promise<string>;
  /** The read's wall-clock timeout in ms; a slower tree degrades to `null`. */
  timeoutMs?: number;
}

/** Spawns the bounded JXA reader via `osascript`, resolving its stdout (empty on failure). */
function spawnOsascriptReader(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", AX_READ_JXA],
      { timeout: timeoutMs, maxBuffer: AX_READ_MAX_BUFFER_BYTES, killSignal: "SIGKILL" },
      (error, stdout) => {
        // A timeout or a non-zero exit is a clean degrade, not a throw: resolve whatever
        // (if anything) was printed, and let the parser turn nothing into `null`.
        if (error !== null) {
          resolve("");
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * The macOS accessibility reader: shells out to the bounded JXA program and parses its
 * output. Every failure path - a spawn error, a timeout, an empty or garbled read - resolves
 * to `null`, so a scene capture always gets "the signal, or nothing" and never a rejection.
 */
export function createMacAxSignalProvider(
  options: MacAxSignalProviderOptions = {},
): AxSignalProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AX_READ_TIMEOUT_MS;
  const runReader = options.runReader ?? (() => spawnOsascriptReader(timeoutMs));

  return {
    async capture(): Promise<RawAxSignal | null> {
      try {
        return parseAxSignalOutput(await runReader());
      } catch {
        return null;
      }
    },
  };
}

/**
 * A provider that always reads nothing - used off macOS (no AX trust model there) so the
 * Screen Agent runs identically, just without floor escalation from the target signal.
 */
export function createNullAxSignalProvider(): AxSignalProvider {
  return { capture: async () => null };
}

/**
 * Builds the accessibility target-signal provider for this platform: the macOS JXA reader on
 * darwin, a no-op reader elsewhere (the M7 Windows port supplies its own behind this same
 * interface).
 */
export function createDesktopAxSignalProvider(): AxSignalProvider {
  return process.platform === "darwin"
    ? createMacAxSignalProvider()
    : createNullAxSignalProvider();
}
