/**
 * The computer-use axis of the Reasoning Vendor table (DECISIONS #11, #14-15).
 *
 * The Screen Agent is a mode of Reasoning, not a new Capability, so it reuses
 * Reasoning's Vendor selection. This table records *which* Reasoning Vendors can
 * actually act and how to talk to their native computer-use surface. It is the single
 * place that answers "is acting available for the currently-routed Vendor?".
 *
 * Both Anthropic (computer-use tool) and Google/Gemini (computer-use model) are
 * computer-use-capable; OpenAI is not and stays advisory (OpenAI's computer-use
 * adapter is new Lune work, a later M2 ticket). Adding a Vendor is a table entry here
 * plus its adapter, mirroring how the OpenAI-compatible Reasoning Vendor table grew.
 *
 * Carried from v1's Sidecar (`agent/computerUseVendors.ts`); the only change is that
 * lookups are keyed off the Core's `ReasoningVendorId` rather than v1's `ProviderId`.
 */
import type { ReasoningVendorId } from "../reasoning/cloudReasoningVendors.js";

/** The Reasoning Vendors that can be flagged computer-use-capable. */
export type ComputerUseVendorId = "anthropic" | "google";

/** One computer-use-capable Vendor's parameters for driving its native surface. */
export interface ComputerUseVendor {
  /** The Reasoning `vendor` value that selects this Vendor. */
  id: ComputerUseVendorId;
  /** Human-readable name, for logs and error messages. */
  displayName: string;
  /**
   * The Vendor's default computer-use-capable model id.
   */
  defaultModel: string;
  /**
   * Whether this Vendor's computer use requires a *dedicated* model distinct from the
   * advisory chat model. When true, an Agent Step always uses `defaultModel` and
   * ignores the config's advisory Reasoning Model Slot (which selects a chat model that
   * cannot drive computer use). When false, the advisory Model Slot doubles as the
   * computer-use model (Anthropic's Claude models support the computer-use tool), so
   * the config's Model Slot is used - keeping the chat "single source of truth" for
   * that Vendor.
   *
   * Google's computer use is a separate `gemini-*-computer-use-*` model from its
   * advisory `gemini-*-flash` vision models, so it is dedicated; Anthropic's is not.
   */
  computerUseModelIsDedicated: boolean;
}

/**
 * The wired computer-use Vendors. Anthropic and Google/Gemini both act; their native
 * computer-use response shapes and conversation protocols differ (Gemini uses
 * normalised coordinates and a `computerUse` tool over `generateContent`), so each has
 * its own adapter, not just a table row.
 */
export const COMPUTER_USE_VENDORS: Partial<Record<ComputerUseVendorId, ComputerUseVendor>> = {
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    // Computer use requires a capable Claude model; this is the advisory default
    // too, so a user who keyed Anthropic can act without changing their Model Slot.
    defaultModel: "claude-sonnet-4-6",
    // Claude chat models support the computer-use tool, so the advisory Model Slot
    // doubles as the computer-use model.
    computerUseModelIsDedicated: false,
  },
  google: {
    id: "google",
    displayName: "Google Gemini",
    // Gemini's dedicated computer-use model (a distinct model from the advisory
    // Gemini vision model), used only when Reasoning is routed to Google for acting.
    defaultModel: "gemini-2.5-computer-use-preview-10-2025",
    // The advisory gemini-*-flash vision model cannot drive computer use; acting must
    // use this dedicated model regardless of the config's advisory Model Slot.
    computerUseModelIsDedicated: true,
  },
};

/**
 * Whether the given Reasoning Vendor is a computer-use Vendor wired for acting. A
 * Vendor that is not in the table (OpenAI) stays advisory: the Screen Agent is simply
 * not offered.
 */
export function findComputerUseVendor(vendorId: ReasoningVendorId): ComputerUseVendor | undefined {
  if (vendorId === "anthropic" || vendorId === "google") {
    return COMPUTER_USE_VENDORS[vendorId];
  }
  return undefined;
}
