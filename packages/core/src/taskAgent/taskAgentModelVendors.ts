/**
 * The wired Task Agent model adapters, one per Reasoning Vendor (M5-01).
 *
 * All three ordinary Reasoning Vendors support tool calling, so any of them can run a
 * Task Agent - the runtime resolves the adapter for the routed Vendor exactly as the
 * chat path resolves a chat adapter. This binds each Vendor id to its adapter, reusing
 * the one source of truth for the OpenAI-compatible endpoints from `cloudReasoningVendors`
 * so a URL never drifts between the chat and Task Agent paths.
 *
 * The Electron main process passes the result straight into
 * {@link import("./taskAgentRuntime.js").TaskAgentRuntimeDependencies.models}; the
 * injected `upstreamFetch` is supplied per request by the runtime, so these adapters are
 * pure factories with no captured transport.
 */
import {
  GEMINI_CHAT_COMPLETIONS_URL,
  OPENAI_CHAT_COMPLETIONS_URL,
  type ReasoningVendorId,
} from "../reasoning/cloudReasoningVendors.js";
import { createAnthropicTaskAgentModel } from "./anthropicTaskAgentModel.js";
import { createOpenAiTaskAgentModel } from "./openAiTaskAgentModel.js";
import type { TaskAgentModel } from "./taskAgentModel.js";

/** Builds the full set of wired Task Agent model adapters, keyed by Vendor id. */
export function createTaskAgentModelAdapters(): Record<ReasoningVendorId, TaskAgentModel> {
  return {
    anthropic: createAnthropicTaskAgentModel(),
    // OpenAI's reasoning families reject `max_tokens` and require `max_completion_tokens`.
    openai: createOpenAiTaskAgentModel({
      chatCompletionsUrl: OPENAI_CHAT_COMPLETIONS_URL,
      displayName: "OpenAI",
      tokenLimitField: "max_completion_tokens",
    }),
    // Gemini's OpenAI-compatible surface still speaks the classic `max_tokens`.
    google: createOpenAiTaskAgentModel({
      chatCompletionsUrl: GEMINI_CHAT_COMPLETIONS_URL,
      displayName: "Google Gemini",
      tokenLimitField: "max_tokens",
    }),
  };
}
