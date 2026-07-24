/**
 * The Core's Screen Agent Capability - the server-side half of the Shell-driven agent
 * loop (DECISIONS #14-15), the successor of v1's `POST /agent-step` handler with HTTP
 * removed.
 *
 * Each Step carries a session id and a fresh screenshot; the Capability feeds the
 * screenshot to the routed computer-use Vendor's adapter, which advances that Vendor's
 * native conversation (held in-process, keyed by session id) and returns exactly one
 * canonical, vendor-independent Action - or a terminal `done` with the final spoken
 * text. The Shell executes the Action, captures the new screen, and calls again;
 * stopping the loop is simply the Shell ceasing to call (that is how Barge-in aborts a
 * turn), so this Capability holds no cadence or abort logic.
 *
 * The Capability is vendor-agnostic: it resolves the adapter for the routed Vendor,
 * drives one Step, applies the Consequence Level floor, and manages the Session - the
 * per-Vendor protocol lives entirely behind the `ComputerUseVendorAdapter` seam.
 * Availability follows the routed Vendor's computer-use axis: a non-computer-use
 * Vendor, an unwired one, or a missing key throws {@link ScreenAgentNotReadyError}
 * WITHOUT any upstream call, exactly like Reasoning's credentials-gating (the typed
 * successor of v1's 503 "not ready").
 *
 * Boundaries stay clean: only the Shell touches the OS (executing Actions, capturing
 * screens); only the Core talks to the Vendor and holds the conversation. The upstream
 * call goes through the injected `UpstreamFetch` so the Core-API tests stub the Vendor
 * boundary. This module imports no HTTP and no Electron - the Electron main process
 * (or a future thin HTTP adapter) bridges `step` to the Shell over typed IPC.
 */
import type { UpstreamFetch } from "../reasoning/upstreamFetch.js";
import type { RoutingConfig } from "../reasoning/routingConfig.js";
import type { AgentAction } from "./agentAction.js";
import { applyConsequenceFloor, type AgentTargetSignal } from "./consequenceFloor.js";
import { findComputerUseVendor, type ComputerUseVendorId } from "./computerUseVendors.js";
import type {
  AgentDisplay,
  AgentScreenshot,
  ComputerUseVendorAdapter,
} from "./computerUseAdapter.js";

/**
 * Thrown before any upstream call when the Screen Agent cannot act for the routed
 * Vendor: the Vendor is not computer-use-capable (or has no wired adapter), or its key
 * is absent. The typed successor of v1's 503 "not ready", mirroring
 * {@link import("../reasoning/reasoningCapability.js").ReasoningNotReadyError} so the
 * Shell surfaces "acting not available" instead of hanging.
 */
export class ScreenAgentNotReadyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ScreenAgentNotReadyError";
  }
}

/**
 * Thrown when a Step's inputs are inconsistent with the Session state: a first Step
 * (no live Session for the id) must carry a goal and the active display's dimensions.
 * The typed successor of v1's 400 "bad request", kept in the Core because the
 * requirement is *stateful* (only a first Step needs a goal), which a static IPC schema
 * cannot express.
 */
export class ScreenAgentStepInputError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ScreenAgentStepInputError";
  }
}

/** One Step the Shell hands the Screen Agent Capability. */
export interface ScreenAgentStepInput {
  /** Identifies the Agent Session; the first Step for an id starts a new Session. */
  sessionId: string;
  /** The fresh screenshot for this Step (full-resolution, single-screen, overlay-excluded). */
  screenshot: AgentScreenshot;
  /** The user's spoken goal. Required on the first Step of a Session. */
  goal?: string;
  /** The active display's dimensions. Required on the first Step (sizes the computer tool). */
  display?: AgentDisplay;
  /**
   * The target signal the Shell supplies so the Core can apply the Consequence Level
   * floor to the Action it returns: the accessibility elements to hit-test the Action's
   * coordinate against, plus the focused element's label/role. Optional - an absent
   * signal simply yields no floor escalation.
   */
  targetSignal?: AgentTargetSignal;
}

/** One Agent Session's in-process state, keyed by session id. */
interface AgentSession {
  /** The computer-use Vendor driving this Session (which adapter owns `state`). */
  vendorId: ComputerUseVendorId;
  /** The adapter's own conversation state, opaque to the Capability. */
  state: unknown;
  /** The single active display the Session is bound to (its coordinate space). */
  display: AgentDisplay;
}

/**
 * Holds the live Agent Sessions in memory, keyed by session id. Deliberately a plain
 * in-memory map: a Session is a single short-lived push-to-talk interaction, and the
 * Shell owns the process lifetime (a Core restart ends any Session, which is the
 * correct outcome). Tests assert external behaviour through `step`, not this store's
 * internals.
 */
class AgentSessionStore {
  private readonly sessionsById = new Map<string, AgentSession>();

  get(sessionId: string): AgentSession | undefined {
    return this.sessionsById.get(sessionId);
  }

  set(sessionId: string, session: AgentSession): void {
    this.sessionsById.set(sessionId, session);
  }

  delete(sessionId: string): void {
    this.sessionsById.delete(sessionId);
  }
}

/** The injected boundaries the Screen Agent Capability is built from. */
export interface ScreenAgentCapabilityDependencies {
  /** Reads the live routing config so a Settings change reconciles which Vendor acts. */
  getRoutingConfig: () => RoutingConfig;
  /** The wired computer-use adapters, keyed by Vendor id. A missing entry = not wired. */
  adapters: Partial<Record<ComputerUseVendorId, ComputerUseVendorAdapter>>;
  /**
   * The Vendor's API key, read live so a key added after start takes effect without
   * rebuilding the Capability. `undefined` gates that Vendor off (not ready).
   */
  getApiKey: (vendorId: ComputerUseVendorId) => string | undefined;
  /** The Vendor boundary (production is `fetch`; tests stub it). */
  upstreamFetch: UpstreamFetch;
}

/** The Core's Screen Agent Capability: advance one Agent Session by one Step. */
export interface ScreenAgentCapability {
  /**
   * Advances the Session identified by `input.sessionId` one Step and returns exactly
   * one canonical Action (or a terminal `done`, which clears the Session). Throws
   * {@link ScreenAgentNotReadyError} (before any upstream call) when the routed Vendor
   * cannot act or has no key, {@link ScreenAgentStepInputError} when a first Step lacks
   * its goal or display, and rethrows an upstream failure so the Shell can stop the
   * Session cleanly.
   */
  step(input: ScreenAgentStepInput): Promise<AgentAction>;
}

export function createScreenAgentCapability(
  dependencies: ScreenAgentCapabilityDependencies,
): ScreenAgentCapability {
  const { getRoutingConfig, adapters, getApiKey, upstreamFetch } = dependencies;
  const sessionStore = new AgentSessionStore();

  async function step(input: ScreenAgentStepInput): Promise<AgentAction> {
    const reasoningSelection = getRoutingConfig().reasoning;
    const vendor = findComputerUseVendor(reasoningSelection.vendor);

    // Gating: the routed Reasoning Vendor must be computer-use-capable AND have a wired
    // adapter. A non-computer-use Vendor (OpenAI) or one with no adapter offers no
    // Screen Agent - not ready, without any upstream call.
    const adapter = vendor === undefined ? undefined : adapters[vendor.id];
    if (vendor === undefined || adapter === undefined) {
      throw new ScreenAgentNotReadyError(
        `The Screen Agent is not available for the '${reasoningSelection.vendor}' Reasoning vendor`,
      );
    }

    // Credentials-gating: no key -> not ready -> throw before touching the network.
    const apiKey = getApiKey(vendor.id);
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ScreenAgentNotReadyError(`${vendor.displayName} credentials are not configured`);
    }

    const sessionId = input.sessionId.trim();
    if (sessionId.length === 0) {
      throw new ScreenAgentStepInputError("The agent step is missing a sessionId");
    }

    const screenshot = input.screenshot;
    if (screenshot.base64Data.length === 0 || screenshot.mediaType.length === 0) {
      throw new ScreenAgentStepInputError("The agent step is missing a valid screenshot");
    }

    // A stored Session for a *different* Vendor is stale (the user re-routed Reasoning
    // mid-Session); its opaque state belongs to the other adapter, so ignore it and
    // treat this as a fresh Session (which requires a goal, cleanly ending the old one).
    const storedSession = sessionStore.get(sessionId);
    const existingSession = storedSession?.vendorId === vendor.id ? storedSession : undefined;

    // Determine the Session's bound display and the adapter's prior state: a new
    // Session needs a goal + display; a continuing one reuses both.
    let display: AgentDisplay;
    let priorState: unknown | undefined;
    let goal: string | undefined;
    if (existingSession === undefined) {
      goal = input.goal?.trim() ?? "";
      if (goal.length === 0) {
        throw new ScreenAgentStepInputError("The first agent step of a session requires a goal");
      }
      const requestedDisplay = readDisplay(input.display);
      if (requestedDisplay === undefined) {
        throw new ScreenAgentStepInputError(
          "The first agent step of a session requires display dimensions",
        );
      }
      display = requestedDisplay;
      priorState = undefined;
    } else {
      // The display is bound for the Session's whole life; ignore any per-Step display
      // and keep the coordinate space stable.
      display = existingSession.display;
      priorState = existingSession.state;
      goal = undefined;
    }

    // Resolve the acting model, asking the *adapter* (not the Vendor) which model it
    // drives - two adapters for one Vendor can differ (OpenAI's dedicated computer-use
    // adapter vs its vision-driven one). When the adapter acts on the advisory Model Slot
    // (Anthropic's computer-use tool, or any vision-driven adapter), that chat slot stays
    // the source of truth, falling back to the Vendor default only when unset. Otherwise
    // the adapter needs a dedicated model (Google/OpenAI computer-use), so the config's
    // advisory Model Slot - which selects a chat model that cannot drive it - is ignored.
    const model = adapter.usesAdvisoryModelSlot
      ? (reasoningSelection.modelSlot.trim().length > 0
          ? reasoningSelection.modelSlot
          : vendor.defaultModel)
      : vendor.defaultModel;

    // Advance the Vendor's conversation by one Step behind the adapter seam. An upstream
    // failure throws out of here, ending the Session cleanly for the Shell to surface.
    const stepResult = await adapter.step({
      priorState,
      goal,
      screenshot,
      display,
      model,
      apiKey,
      upstreamFetch,
    });

    // Apply the escalate-only Consequence Level floor: raise the Action's level to
    // max(model tag, hardcoded floor) using the target signal, so a model that
    // under-flags an irreversible Action cannot slip it past the Confirm Gate.
    const classifiedAction = applyConsequenceFloor(stepResult.action, input.targetSignal);

    if (classifiedAction.kind === "done" || stepResult.nextState === undefined) {
      // Terminal: the goal is met. Drop the Session so its id can't be reused.
      sessionStore.delete(sessionId);
    } else {
      sessionStore.set(sessionId, {
        vendorId: vendor.id,
        state: stepResult.nextState,
        display,
      });
    }

    return classifiedAction;
  }

  return { step };
}

/** Validates the active-display dimensions supplied on a first Step. */
function readDisplay(display: AgentDisplay | undefined): AgentDisplay | undefined {
  if (display === undefined) {
    return undefined;
  }
  if (!(display.width > 0) || !(display.height > 0)) {
    return undefined;
  }
  return { width: display.width, height: display.height };
}
