/**
 * The typed tool contract a Task Agent calls (M5-01).
 *
 * A Task Agent works through tools only - never the user's input devices or screen
 * (DECISIONS #14). The runtime knows a tool by three things: a name, a description, and
 * a JSON-Schema description of its parameters - exactly the shape every ordinary
 * tool-calling model wants in its tool list, so a tool is declared once and each Vendor
 * adapter translates it to that Vendor's own wire format (`input_schema` for Anthropic,
 * `function.parameters` for the OpenAI-compatible Vendors).
 *
 * Executing the tool is the one injected boundary: this ticket drives *stubbed* tools so
 * the runtime is unit-testable at its seam; M5-02 supplies the real local tools (open
 * URL, AppleScript, shell, file writes) and wraps their `execute` with the Confirm Gate,
 * so the runtime here stays free of any tool-safety knowledge.
 */

/**
 * A JSON-Schema object describing a tool's parameters, passed to the model verbatim.
 * Kept as a plain JSON-Schema object (not a zod schema) because that is the exact shape
 * both the Anthropic and OpenAI-compatible tool APIs expect on the wire; the index
 * signature lets a tool carry any other JSON-Schema keyword it needs
 * (`additionalProperties`, nested `enum`s, ...).
 */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
  [keyword: string]: unknown;
}

/** The schema half of a tool - the name/description/parameters the model is told about. */
export interface ToolSchema {
  /** The tool's identifier, matched against the model's requested tool name. */
  name: string;
  /** A short natural-language description guiding the model on when to use the tool. */
  description: string;
  /** The JSON-Schema of the tool's parameters. */
  parameters: ToolParameterSchema;
}

/** The per-call context the runtime hands a tool. */
export interface ToolExecutionContext {
  /** The Task Agent Session this call belongs to. */
  sessionId: string;
  /**
   * Aborts a long-running tool when the Session is cancelled, so a cancel doesn't wait
   * on an in-flight tool (a slow download, a shell command). A tool that cannot be
   * interrupted may ignore it; the runtime discards the result of an aborted call.
   */
  signal: AbortSignal;
}

/**
 * The result of one tool call, fed back to the model as the tool's output on the next
 * turn. `isError` marks a *recoverable* failure (a bad argument, a 404) that the model
 * sees and can react to - the Session keeps running; an unrecoverable failure is thrown,
 * which the runtime turns into a failed Session.
 */
export interface ToolExecutionResult {
  /** The tool's output text, returned to the model as the tool-result content. */
  output: string;
  /** True when the tool failed recoverably; the model is shown an error result. */
  isError?: boolean;
}

/** One typed tool a Task Agent can call. */
export interface TaskAgentTool extends ToolSchema {
  /**
   * Runs the tool for one call. The runtime never inspects a tool beyond calling this,
   * so the whole local tool set (M5-02) and its Confirm Gate live entirely behind it.
   */
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
