/**
 * The MCP server manager (M6-01): the Core's owner of every configured MCP server's
 * lifecycle - connect, discover, enable/disable, health, and graceful teardown - and the
 * source of the live MCP tool set the composite registry hands the Task Agent runtime.
 *
 * It is the MCP analogue of the local tool set's assembly, one level up: where the local set
 * is a fixed array, MCP tools come and go as servers connect and fail, so the manager tracks
 * each server's {@link McpServerState} and exposes the *current* tools of the *ready* ones.
 * The three epic acceptances live here:
 *   - a configured server's tools appear and are callable - `start` connects it, discovers
 *     its tools via the connection, and {@link translateMcpTool}s them into the registry;
 *   - server failures degrade gracefully - a connect/discovery failure becomes an `error`
 *     status with no tools and no exception, leaving every other server untouched, and a
 *     server disabled or dropped mid-run simply stops contributing tools;
 *   - consequential third-party calls trip the Confirm Gate - each tool is translated against
 *     the injected gate, so the gating is inherent to every MCP tool the manager produces.
 *
 * The Core owns the logic; the transport is the injected {@link McpConnector}'s (the Shell's
 * real MCP SDK client). State changes publish to subscribers for the Settings surface (M6-02).
 */
import type { ToolConfirmGate } from "../toolConfirm.js";
import type { TaskAgentTool } from "../toolTypes.js";
import type { McpConnector, McpServerConnection } from "./mcpConnection.js";
import type { McpServerConfig } from "./mcpServerConfig.js";
import { translateMcpTool } from "./mcpToolTranslation.js";

/**
 * One server's health, as the Settings surface renders it. `disabled` is a configured server
 * the user turned off (no connection attempted); `connecting` is an in-flight attempt;
 * `ready` means its tools are live; `error` means the last attempt failed and `error` carries
 * the readable reason (the tools are absent until a `refresh` succeeds).
 */
export type McpServerStatus = "disabled" | "connecting" | "ready" | "error";

/** A point-in-time view of one configured server. */
export interface McpServerState {
  /** The server's configured id. */
  id: string;
  /** The server's human label. */
  displayName: string;
  /** The server's current health. */
  status: McpServerStatus;
  /** How many tools it currently contributes (0 unless `ready`). */
  toolCount: number;
  /** The readable failure reason, present only when `status` is `error`. */
  error?: string;
}

/** The injected boundaries the manager is built from. */
export interface McpServerManagerDependencies {
  /** Opens a transport-level connection to a server (the Shell's real MCP SDK client). */
  connector: McpConnector;
  /** The Confirm Gate every consequential third-party call must pass (the Shell's voice gate). */
  confirm: ToolConfirmGate;
  /** The initial configured server set; more can be applied later via {@link McpServerManager.configure}. */
  servers?: readonly McpServerConfig[];
}

/** A subscriber notified whenever one server's state changes. */
export type McpServerStateListener = (state: McpServerState) => void;

/** The MCP server manager: connect, observe, enable/disable, and tear down MCP servers. */
export interface McpServerManager {
  /** Connects every enabled configured server, in parallel; resolves once all have settled. */
  start(): Promise<void>;
  /** The live tools of all currently-ready servers, for the composite registry provider. */
  listTools(): readonly TaskAgentTool[];
  /** The current state of every configured server, in configuration order. */
  states(): McpServerState[];
  /** Turns a server on (connect) or off (disconnect); persists onto its config. */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Re-attempts a server: disconnect then (if enabled) reconnect - the retry after an error. */
  refresh(id: string): Promise<void>;
  /** Applies a new configured set: adds/removes servers and reconnects changed ones. */
  configure(servers: readonly McpServerConfig[]): Promise<void>;
  /** Subscribes to per-server state changes; returns an unsubscribe function. */
  subscribe(listener: McpServerStateListener): () => void;
  /** Closes every connection (app shutdown). */
  close(): Promise<void>;
}

/** One server's live in-process record. */
interface ManagedServer {
  config: McpServerConfig;
  status: McpServerStatus;
  connection: McpServerConnection | null;
  tools: TaskAgentTool[];
  error?: string;
  /**
   * Bumped on every lifecycle operation for this server, so a slow in-flight connect whose
   * server was since disabled/reconfigured is discarded instead of resurrecting stale state
   * (the fix for a connect racing a disable).
   */
  generation: number;
}

export function createMcpServerManager(
  dependencies: McpServerManagerDependencies,
): McpServerManager {
  const { connector, confirm } = dependencies;
  const servers = new Map<string, ManagedServer>();
  const order: string[] = [];
  const listeners = new Set<McpServerStateListener>();

  for (const config of dependencies.servers ?? []) {
    addServerRecord(config);
  }

  function addServerRecord(config: McpServerConfig): ManagedServer {
    const server: ManagedServer = {
      config,
      status: config.enabled ? "connecting" : "disabled",
      connection: null,
      tools: [],
      generation: 0,
    };
    servers.set(config.id, server);
    order.push(config.id);
    return server;
  }

  function toState(server: ManagedServer): McpServerState {
    return {
      id: server.config.id,
      displayName: server.config.displayName,
      status: server.status,
      toolCount: server.tools.length,
      error: server.error,
    };
  }

  function publish(server: ManagedServer): void {
    const state = toState(server);
    for (const listener of [...listeners]) {
      listener(state);
    }
  }

  /**
   * Opens (or re-opens) one server's connection, discovers and translates its tools, and
   * records the outcome as `ready` or `error`. Never throws: a failure is a clean `error`
   * state, so one bad server can't fail `start` or disturb the others. The generation guard
   * discards the result if the server was disabled or reconfigured while connecting.
   */
  async function connect(server: ManagedServer): Promise<void> {
    if (!server.config.enabled) {
      return;
    }
    const generation = (server.generation += 1);
    server.status = "connecting";
    server.error = undefined;
    server.tools = [];
    publish(server);

    let connection: McpServerConnection;
    try {
      connection = await connector(server.config);
      const definitions = await connection.listTools();
      if (server.generation !== generation) {
        // Superseded mid-connect (disabled / reconfigured): drop this connection quietly.
        await safeClose(connection);
        return;
      }
      server.connection = connection;
      server.tools = definitions.map((definition) =>
        translateMcpTool(definition, {
          serverId: server.config.id,
          serverDisplayName: server.config.displayName,
          connection,
          confirm,
        }),
      );
      server.status = "ready";
      server.error = undefined;
      // Learn of the server dropping *after* it went ready, so its tools vanish promptly
      // instead of lingering until the next call fails. The generation guard ignores a close
      // triggered by our own deliberate teardown (disconnect / refresh / shutdown bumps it).
      connection.onClose?.((reason) => handleUnexpectedClose(server, generation, reason));
      publish(server);
    } catch (error) {
      if (server.generation !== generation) {
        return;
      }
      server.connection = null;
      server.tools = [];
      server.status = "error";
      server.error = errorMessage(error);
      publish(server);
    }
  }

  /**
   * Handles a ready server's connection closing on its own (process exit, dropped session):
   * marks it `error` with its tools gone, so the live registry stops offering them. Ignored
   * when the server has since moved on (a newer generation) or is no longer `ready` - which
   * is what filters out the close our own teardown provokes.
   */
  function handleUnexpectedClose(server: ManagedServer, generation: number, reason?: string): void {
    if (server.generation !== generation || server.status !== "ready") {
      return;
    }
    server.connection = null;
    server.tools = [];
    server.status = "error";
    server.error = reason ?? "The MCP server connection closed unexpectedly";
    publish(server);
  }

  /** Tears down one server's connection and marks it `disabled`, discarding its tools. */
  async function disconnect(server: ManagedServer): Promise<void> {
    server.generation += 1;
    const connection = server.connection;
    server.connection = null;
    server.tools = [];
    server.status = "disabled";
    server.error = undefined;
    publish(server);
    if (connection !== null) {
      await safeClose(connection);
    }
  }

  async function start(): Promise<void> {
    await Promise.all(
      order.map((id) => {
        const server = servers.get(id);
        return server !== undefined && server.config.enabled ? connect(server) : Promise.resolve();
      }),
    );
  }

  function listTools(): readonly TaskAgentTool[] {
    const tools: TaskAgentTool[] = [];
    for (const id of order) {
      const server = servers.get(id);
      if (server !== undefined && server.status === "ready") {
        tools.push(...server.tools);
      }
    }
    return tools;
  }

  function states(): McpServerState[] {
    return order.map((id) => toState(servers.get(id)!));
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    const server = servers.get(id);
    if (server === undefined || server.config.enabled === enabled) {
      return;
    }
    server.config = { ...server.config, enabled };
    if (enabled) {
      await connect(server);
    } else {
      await disconnect(server);
    }
  }

  async function refresh(id: string): Promise<void> {
    const server = servers.get(id);
    if (server === undefined) {
      return;
    }
    const connection = server.connection;
    server.connection = null;
    if (connection !== null) {
      await safeClose(connection);
    }
    if (server.config.enabled) {
      await connect(server);
    } else {
      await disconnect(server);
    }
  }

  async function configure(nextConfigs: readonly McpServerConfig[]): Promise<void> {
    const nextById = new Map(nextConfigs.map((config) => [config.id, config]));
    const work: Promise<void>[] = [];

    // Remove servers no longer configured.
    for (const id of [...order]) {
      if (!nextById.has(id)) {
        const server = servers.get(id)!;
        work.push(disconnect(server).then(() => dropServer(id)));
      }
    }

    // Add new servers and reconnect changed ones; leave unchanged servers alone.
    for (const config of nextConfigs) {
      const existing = servers.get(config.id);
      if (existing === undefined) {
        const added = addServerRecord(config);
        if (added.config.enabled) {
          work.push(connect(added));
        } else {
          publish(added);
        }
      } else if (!sameConfig(existing.config, config)) {
        existing.config = config;
        work.push(refresh(config.id));
      }
    }

    await Promise.all(work);
  }

  function dropServer(id: string): void {
    servers.delete(id);
    const index = order.indexOf(id);
    if (index !== -1) {
      order.splice(index, 1);
    }
  }

  async function close(): Promise<void> {
    await Promise.all(
      [...servers.values()].map(async (server) => {
        server.generation += 1;
        const connection = server.connection;
        server.connection = null;
        server.tools = [];
        if (connection !== null) {
          await safeClose(connection);
        }
      }),
    );
  }

  return {
    start,
    listTools,
    states,
    setEnabled,
    refresh,
    configure,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}

/** Deep-equals two configs by value, so `configure` only reconnects a genuinely changed one. */
function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Closes a connection without letting a close failure propagate (best-effort teardown). */
async function safeClose(connection: McpServerConnection): Promise<void> {
  try {
    await connection.close();
  } catch {
    // A transport that fails to close is already gone; nothing to recover.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
