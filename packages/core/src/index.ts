import { LUNE_IPC_VERSION } from "@lune/shared";

// @lune/core is the pure, transport-agnostic TypeScript package that owns all of
// Lune's intelligence (developer story 45). It imports no Electron and no HTTP:
// the Electron main process (or, later, a thin HTTP adapter) is what bridges these
// plain typed functions/streams to a Shell. This ticket (03) ports v1's full cloud
// Reasoning core - three Vendors behind the Vendor table, credentials-gated and
// config-routed, running one shared pipeline with the Point Tag canonicalizer and
// coordinate remap. The remaining Capabilities (Transcription, Speech) and local
// Runtimes are ported in later tickets.

// The Reasoning Capability and its Vendor-independent request/event types.
export {
  createReasoningCapability,
  ReasoningNotReadyError,
  type ReasoningCapability,
  type ReasoningCapabilityDependencies,
} from "./reasoning/reasoningCapability.js";
export {
  textOnlyChatRequest,
  screenAwareChatRequest,
  type ScreenCaptureInput,
  type CoreChatRequest,
  type CoreChatMessage,
  type CoreContentBlock,
  type CoreChatStreamEvent,
  type Screenshot,
  type DownscaledScreenshot,
  type DownscaleScreenshot,
} from "./reasoning/chatTypes.js";

// The Vendor table: the three cloud Reasoning Vendors and their protocol adapters.
export {
  REASONING_VENDORS,
  REASONING_VENDOR_IDS,
  findReasoningVendor,
  type ReasoningVendor,
  type ReasoningVendorId,
} from "./reasoning/cloudReasoningVendors.js";

// The routing config: which Vendor + Model Slot answers, Gemini by default.
export {
  DEFAULT_ROUTING_CONFIG,
  parseRoutingConfig,
  loadRoutingConfig,
  RoutingConfigStore,
  type RoutingConfig,
  type ReasoningSelection,
} from "./reasoning/routingConfig.js";

// The answer Point Tag parser: splits a finished answer into the clean display text
// the Overlay's bubble shows and the pointing directive it acts on (ticket 07). The
// canonicalizer above repairs the tag into the canonical grammar; this reads it back.
export {
  parseAnswerPointTag,
  type ParsedAnswer,
  type ParsedPoint,
  type PointDirective,
} from "./reasoning/pointTagParser.js";

export { CANONICAL_SYSTEM_PROMPT } from "./reasoning/canonicalSystemPrompt.js";
export type { UpstreamFetch } from "./reasoning/upstreamFetch.js";

// The conversation model: the Core-owned multi-turn history the Chat Panel renders,
// and the manager that advances it one turn at a time through the Reasoning Capability.
export {
  createConversationManager,
  type ConversationManager,
  type ConversationManagerDependencies,
  type SubmitUserTurnInput,
} from "./conversation/conversationManager.js";
export { buildConversationRequest } from "./conversation/buildConversationRequest.js";
export type {
  ChatInputMethod,
  ConversationMessage,
  UserConversationMessage,
  AssistantConversationMessage,
  CoreConversationEvent,
} from "./conversation/conversationTypes.js";

/**
 * Human-readable identifier for this Core build, stamped with the IPC contract
 * version it was compiled against. The Shell surfaces it so the Shell<->Core
 * wiring (and version agreement) can be confirmed at a glance.
 */
export function describeCore(): string {
  return `Lune Core (IPC v${LUNE_IPC_VERSION})`;
}
