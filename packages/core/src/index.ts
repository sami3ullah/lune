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
  type StreamChatOptions,
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

// The cheap key-validation call the onboarding key step uses to live-validate a Vendor
// key before it is stored (ticket 14): one one-token request through the Vendor adapter,
// verdict as a plain reason.
export {
  validateReasoningKey,
  type KeyValidationResult,
  type ValidateReasoningKeyInput,
} from "./reasoning/validateReasoningKey.js";

// The routing config: which Vendor + Model Slot answers, Gemini by default.
export {
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  parseRoutingConfig,
  loadRoutingConfig,
  RoutingConfigStore,
  type RoutingConfig,
  type ReasoningSelection,
  type SpeechSelection,
  type HotkeySelection,
} from "./reasoning/routingConfig.js";

// The Speech Capability: on-device Kokoro synthesis (ticket 09), gated on the Kokoro
// weights being provisioned. The Core owns the seam, the 54-Voice list, and the pure
// tokenize/style/WAV transforms; the Electron main process injects the real
// in-process onnxruntime-node engine and sentence-streams answers through it.
export {
  createSpeechCapability,
  type SpeechCapability,
  type SpeechCapabilityDependencies,
} from "./speech/speechCapability.js";
export {
  SpeechEngineNotReadyError,
  createDeferredKokoroSpeechEngine,
  type KokoroSpeechEngine,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
} from "./speech/speechEngine.js";
export {
  KOKORO_VOICES,
  DEFAULT_KOKORO_VOICE,
  isKnownKokoroVoice,
} from "./speech/kokoroVoices.js";
export {
  KOKORO_SAMPLE_RATE_HZ,
  KOKORO_STYLE_DIMENSION,
  KOKORO_MAX_TOKENS,
  KOKORO_TOKEN_VOCAB,
  phonemesToTokenIds,
  buildInputIds,
  selectStyleVector,
  encodeWavFromFloatPcm,
} from "./speech/kokoroSynthesis.js";

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

// The Provisioning Capability: the background model-download subsystem (pinned
// manifest, resumable checksum-verified downloads, preflight, live progress, cancel,
// per-Runtime readiness), ported from v1 minus LM Studio (Lune has no local
// Reasoning). Its gateway interfaces are the injected network/fs/disk boundaries the
// Electron main process fills with Node-backed impls and tests fill with fakes.
export {
  createProvisioningCapability,
  type ProvisioningCapability,
  type ProvisioningCapabilityDependencies,
} from "./provisioning/provisioningCapability.js";
export {
  PROVISIONING_MANIFEST,
  allArtifacts,
  findRuntime,
  resolveRuntimes,
  runtimeDownloadBytes,
  totalDownloadBytes,
  type PinnedArtifact,
  type ProvisionableRuntime,
  type ProvisionableRuntimeId,
} from "./provisioning/manifest.js";
export type {
  ProvisioningGateways,
  RangeDownloadGateway,
  DownloadStream,
  ResumeFrom,
  FileSystemGateway,
  DiskSpaceProbe,
  NetworkProbe,
} from "./provisioning/gateways.js";
export type {
  ProvisioningStatus,
  ProvisioningPhase,
} from "./provisioning/controller.js";
export type {
  ProvisioningProgress,
  RuntimeResult,
  ArtifactResult,
  ArtifactOutcome,
} from "./provisioning/orchestrator.js";
export type {
  PreflightResult,
  PreflightFailureReason,
} from "./provisioning/preflight.js";
export {
  ChecksumMismatchError,
  ProvisioningCancelledError,
  type DownloadProgress,
} from "./provisioning/download.js";

// The Transcription Capability: on-device batch speech-to-text via the supervised
// whisper.cpp child Runtime (ADR-0003, ADR-0006), ported from v1 scoped to whisper.
// A recorded WAV clip in, one transcript out; gated on the weights being provisioned
// AND the child Runtime healthy. The Core owns the supervision + readiness logic and
// the Provider->Runtime seam; the Electron main process fills the gateway/transcribe
// seam with the real whisper-server spawn/health/HTTP edge, and a test fills it with
// stubs.
export {
  createTranscriptionCapability,
  TranscriptionNotReadyError,
  EmptyTranscriptionAudioError,
  type TranscriptionCapability,
  type TranscriptionCapabilityDependencies,
} from "./transcription/transcriptionCapability.js";
export type {
  TranscribeAudio,
  TranscriptionResult,
} from "./transcription/whisperTranscription.js";
export {
  ChildRuntimeSupervisor,
  type ChildRuntimeGateway,
  type ChildRuntimeId,
  type ChildRuntimeState,
} from "./transcription/childRuntimeSupervisor.js";

// The Screen Agent Capability: the Core's half of the Shell-driven agent loop (M2,
// DECISIONS #14-15), ported from v1. It advances one Agent Session by one Step against
// the routed computer-use Vendor's adapter, returns exactly one canonical,
// vendor-independent Action (or terminal done), and applies the escalate-only
// Consequence Level floor. Gated on the routed Vendor's computer-use capability + key
// (typed not-ready, no upstream call, otherwise). Anthropic + Gemini + OpenAI adapters
// are wired; the Electron main process injects `fetch` + the per-Vendor keys, and a test
// injects stubs. Only the Shell touches the OS; only the Core talks to the Vendor.
export {
  createScreenAgentCapability,
  ScreenAgentNotReadyError,
  ScreenAgentStepInputError,
  type ScreenAgentCapability,
  type ScreenAgentCapabilityDependencies,
  type ScreenAgentStepInput,
} from "./agent/screenAgentCapability.js";
export type {
  AgentAction,
  ClickAction,
  TypeAction,
  KeyAction,
  ScrollAction,
  CopyAction,
  ObserveAction,
  DoneAction,
  ConsequenceLevel,
  ScrollDirection,
} from "./agent/agentAction.js";
export { escalateConsequence } from "./agent/agentAction.js";
export {
  applyConsequenceFloor,
  resolveConsequenceFloor,
  type AgentTargetSignal,
  type TargetElement,
} from "./agent/consequenceFloor.js";
export {
  findComputerUseVendor,
  COMPUTER_USE_VENDORS,
  type ComputerUseVendor,
  type ComputerUseVendorId,
} from "./agent/computerUseVendors.js";
export {
  createAnthropicComputerUseAdapter,
} from "./agent/anthropicComputerUse.js";
export {
  createGeminiComputerUseAdapter,
} from "./agent/geminiComputerUse.js";
export {
  createOpenAiComputerUseAdapter,
} from "./agent/openAiComputerUse.js";
export {
  AGENT_SYSTEM_PROMPT,
} from "./agent/agentSystemPrompt.js";
export type {
  AgentScreenshot,
  AgentDisplay,
  ComputerUseVendorAdapter,
  ComputerUseStepInput,
  ComputerUseStepResult,
} from "./agent/computerUseAdapter.js";

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
