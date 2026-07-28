/**
 * The MCP authentication signal (M6-02): the one distinguished failure the connector raises
 * when a server refuses the connection for want of authorization - an OAuth server with no
 * token yet, or a token that has expired and could not be refreshed.
 *
 * The Core stays transport-agnostic (it imports no MCP SDK, no HTTP), so it cannot inspect a
 * 401 itself. Instead the injected connector (the Shell's real SDK client) recognises the
 * unauthorized condition and rejects with this error; the {@link import("./mcpServerManager.js").McpServerManager}
 * catches it and reports the server as `auth-expired` rather than a generic `error`. That is
 * the whole reason the Settings surface can tell "needs sign-in" apart from "is broken"
 * (M6-02 acceptance: status connected/erroring/auth-expired visible and explained), without
 * the Core learning anything about OAuth.
 *
 * Any other failure (a spawn error, an unreachable URL, a handshake mismatch) stays an
 * ordinary rejection the manager renders as `error`.
 */
export class McpAuthRequiredError extends Error {
  constructor(message = "The MCP server requires authorization") {
    super(message);
    this.name = "McpAuthRequiredError";
  }
}
