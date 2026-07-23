import type { ProvisioningStatus } from "@lune/core";
import type { ReadinessRow } from "../../ipc/settings";

// The per-Capability readiness rows the Settings surface shows (ticket 13 acceptance:
// "Readiness rows mirror the Core status - e.g. 'Transcription: downloading 40%',
// 'Reasoning: no key'"). This is the pure mapping from the two Core signals the main
// process can read - the routed Vendor's credentials-gating and the Provisioning
// run's live progress + per-Runtime verified state - into the three rows the UI
// renders, so a not-ready Capability is always explained rather than a silent hang.
//
// It is the Lune counterpart of v1's `/status` report + provisioning-status summary,
// folded into one pure function so it is unit-testable without a running app.

/** The inputs the main process gathers from the Core to derive the readiness rows. */
export interface ReadinessInput {
  /** The routed Reasoning Vendor and whether it currently has a stored key. */
  reasoning: { vendorDisplayName: string; keyed: boolean };
  /** The live Provisioning run snapshot (phase, progress bytes, preflight failure). */
  provisioning: Pick<ProvisioningStatus, "phase" | "downloadedBytes" | "totalBytes" | "preflightFailure">;
  /** Whether the whisper (Transcription) weights are provisioned + verified. */
  whisperReady: boolean;
  /** Whether the Kokoro (Speech) weights are provisioned + verified. */
  kokoroReady: boolean;
}

/** The download percent for a running provisioning run, clamped to 0..100. */
function downloadPercent(downloadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)));
}

/**
 * The readiness row for a local Capability whose model weights are provisioned: ready
 * when its weights verify, "downloading NN%" while a run is in flight, and an
 * explained not-ready otherwise (preflight failure, a failed run, or simply not yet
 * downloaded) - never a bare "not ready" with no reason.
 */
function localRuntimeRow(
  capability: ReadinessRow["capability"],
  label: string,
  runtimeReady: boolean,
  provisioning: ReadinessInput["provisioning"],
): ReadinessRow {
  if (runtimeReady) {
    return { capability, label, ready: true, state: "ready", detail: "Ready" };
  }
  if (provisioning.phase === "running") {
    const percent = downloadPercent(provisioning.downloadedBytes, provisioning.totalBytes);
    return { capability, label, ready: false, state: "downloading", detail: `Downloading ${percent}%` };
  }
  if (provisioning.preflightFailure !== undefined) {
    return {
      capability,
      label,
      ready: false,
      state: "not-ready",
      detail: provisioning.preflightFailure.detail,
    };
  }
  if (provisioning.phase === "failed") {
    return { capability, label, ready: false, state: "not-ready", detail: "Download failed - use Repair" };
  }
  return { capability, label, ready: false, state: "not-ready", detail: "Model not downloaded yet" };
}

/**
 * Derives the three readiness rows - Reasoning, Transcription, Speech - from the Core
 * signals. Reasoning is credentials-gated (ready iff the routed Vendor has a key, else
 * "no key"); Transcription and Speech are provisioned-model rows sharing the one
 * Provisioning run's progress.
 */
export function deriveReadinessRows(input: ReadinessInput): ReadinessRow[] {
  const reasoningRow: ReadinessRow = input.reasoning.keyed
    ? { capability: "reasoning", label: "Reasoning", ready: true, state: "ready", detail: "Ready" }
    : {
        capability: "reasoning",
        label: "Reasoning",
        ready: false,
        state: "not-ready",
        detail: `No API key for ${input.reasoning.vendorDisplayName}`,
      };

  return [
    reasoningRow,
    localRuntimeRow("transcription", "Transcription", input.whisperReady, input.provisioning),
    localRuntimeRow("speech", "Speech", input.kokoroReady, input.provisioning),
  ];
}
