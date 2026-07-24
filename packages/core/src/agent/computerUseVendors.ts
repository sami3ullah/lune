/**
 * The computer-use axis of the Reasoning Vendor table (DECISIONS #11, #14-15).
 *
 * The Screen Agent is a mode of Reasoning, not a new Capability, so it reuses
 * Reasoning's Vendor selection. This table records *which* Reasoning Vendors can
 * actually act and how to talk to their native computer-use surface. It is the single
 * place that answers "is acting available for the currently-routed Vendor?".
 *
 * Anthropic (computer-use tool), Google/Gemini (computer-use model), and OpenAI
 * (computer_use_preview over the Responses API) are all computer-use-capable. OpenAI's
 * adapter is new Lune work (v1 had OpenAI advisory-only). Adding a Vendor is a table
 * entry here plus its adapter, mirroring how the OpenAI-compatible Reasoning Vendor
 * table grew.
 *
 * Carried from v1's Sidecar (`agent/computerUseVendors.ts`); the only change is that
 * lookups are keyed off the Core's `ReasoningVendorId` rather than v1's `ProviderId`.
 */
import type { ReasoningVendorId } from "../reasoning/cloudReasoningVendors.js";

/** The Reasoning Vendors that can be flagged computer-use-capable. */
export type ComputerUseVendorId = "anthropic" | "google" | "openai";

/** One computer-use-capable Vendor's parameters for driving its native surface. */
export interface ComputerUseVendor {
  /** The Reasoning `vendor` value that selects this Vendor. */
  id: ComputerUseVendorId;
  /** Human-readable name, for logs and error messages. */
  displayName: string;
  /**
   * The Vendor's default computer-use-capable model id, used by the adapters that need a
   * *dedicated* acting model (Google's `gemini-*-computer-use-*`, OpenAI's
   * `computer-use-preview`) and as the fallback when the advisory Model Slot is unset.
   * Whether a given adapter uses this or the advisory chat slot is the adapter's own
   * `usesAdvisoryModelSlot` flag, not a Vendor-wide fact - the vision-driven adapter acts
   * on the chat slot for the very same Vendor.
   */
  defaultModel: string;
}

/**
 * The wired computer-use Vendors. Anthropic, Google/Gemini, and OpenAI all act; their
 * native computer-use response shapes and conversation protocols differ (Gemini uses
 * normalised coordinates and a `computerUse` tool over `generateContent`; OpenAI uses a
 * `computer_use_preview` tool over the Responses API), so each has its own adapter, not
 * just a table row.
 */
export const COMPUTER_USE_VENDORS: Partial<Record<ComputerUseVendorId, ComputerUseVendor>> = {
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    // Computer use requires a capable Claude model; this is the advisory default
    // too, so a user who keyed Anthropic can act without changing their Model Slot.
    defaultModel: "claude-sonnet-4-6",
  },
  google: {
    id: "google",
    displayName: "Google Gemini",
    // Gemini's dedicated computer-use model (a distinct model from the advisory
    // Gemini vision model), used only when Reasoning is routed to Google for acting.
    defaultModel: "gemini-2.5-computer-use-preview-10-2025",
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    // OpenAI's dedicated computer-use-preview model over the Responses API - a distinct
    // model from the advisory gpt-* chat models. Used by the dedicated OpenAI computer-use
    // adapter; the vision-driven OpenAI adapter instead acts on the gpt-* chat slot.
    defaultModel: "computer-use-preview",
  },
};

/**
 * Whether the given Reasoning Vendor is a computer-use Vendor wired for acting. All
 * three cloud Reasoning Vendors now act; a Vendor absent from the table would stay
 * advisory (the Screen Agent simply not offered), but the guard is exhaustive today.
 */
export function findComputerUseVendor(vendorId: ReasoningVendorId): ComputerUseVendor | undefined {
  if (vendorId === "anthropic" || vendorId === "google" || vendorId === "openai") {
    return COMPUTER_USE_VENDORS[vendorId];
  }
  return undefined;
}
