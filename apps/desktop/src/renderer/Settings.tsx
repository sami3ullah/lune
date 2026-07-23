import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "./settingsStore";
import type { ReadinessRow, SettingsCatalog, SettingsValues, SettingsVendorId } from "../ipc/settings";
import { displayHotkeyToken, validateHotkeyToken } from "../ipc/hotkey";

// The Settings surface (ticket 13): the persistent control surface opened from the
// Pill. It shares the Pill/Chat Panel design language (dark, rounded, blurred) and is
// its own window. Every committed change applies immediately (persisted, then routed on
// the next turn) - there is no separate Save button, matching v1: pick a Vendor, a
// Model, a Voice, a hotkey, or flip the streaming toggle and it takes effect. API keys
// go straight to OS-encrypted storage and gate Vendor selectability the moment they
// change; a not-ready Capability is always explained in the readiness rows.

/** How often to re-poll readiness while a model download is in flight (for the % bar). */
const READINESS_POLL_MS = 1500;

export function Settings() {
  const loaded = useSettingsStore((state) => state.loaded);
  const catalog = useSettingsStore((state) => state.catalog);
  const values = useSettingsStore((state) => state.values);
  const keyedVendors = useSettingsStore((state) => state.keyedVendors);
  const readiness = useSettingsStore((state) => state.readiness);
  const load = useSettingsStore((state) => state.load);
  const save = useSettingsStore((state) => state.save);
  const refreshReadiness = useSettingsStore((state) => state.refreshReadiness);

  useEffect(() => {
    void load();
  }, [load]);

  // While any Capability is downloading, poll readiness so the "Downloading NN%" row
  // advances live (the repair/onboarding download bar). Stops once nothing is downloading.
  const anyDownloading = readiness.some((row) => row.state === "downloading");
  useEffect(() => {
    if (!anyDownloading) {
      return;
    }
    const timer = setInterval(() => void refreshReadiness(), READINESS_POLL_MS);
    return () => clearInterval(timer);
  }, [anyDownloading, refreshReadiness]);

  // Apply a partial edit: merge over the current values and persist. Each committed
  // control change flows through here, so the Core routes with the new selection next turn.
  const applyValues = useCallback(
    (patch: Partial<SettingsValues>) => {
      if (values === null) {
        return;
      }
      void save({ ...values, ...patch });
    },
    [save, values],
  );

  if (!loaded || catalog === null || values === null) {
    return (
      <Shell>
        <p className="px-4 py-6 text-center text-xs text-neutral-500">Loading settings…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <ReadinessSection readiness={readiness} />

        <ReasoningSection
          catalog={catalog}
          values={values}
          keyedVendors={keyedVendors}
          onSelectVendor={(vendor) => {
            const defaultModel =
              catalog.vendors.find((candidate) => candidate.id === vendor)?.defaultModel ?? "";
            applyValues({ reasoning: { vendor, modelSlot: defaultModel } });
          }}
          onSetModelSlot={(modelSlot) =>
            applyValues({ reasoning: { vendor: values.reasoning.vendor, modelSlot } })
          }
        />

        <VoiceSection
          voices={catalog.voices}
          voice={values.speech.voice}
          onSelectVoice={(voice) => applyValues({ speech: { voice } })}
        />

        <HotkeySection hotkey={values.hotkey} onChange={(hotkey) => applyValues({ hotkey })} />

        <Section title="Overlay">
          <ToggleRow
            label="Show streaming text"
            hint="Show Lune's answer beside the cursor while it speaks. Off = voice only."
            checked={values.streamingText}
            onChange={(streamingText) => applyValues({ streamingText })}
          />
        </Section>

        <ApiKeysSection catalog={catalog} keyedVendors={keyedVendors} />
      </div>
    </Shell>
  );
}

/** The window chrome: draggable header + close, matching the Chat Panel. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden border border-white/10 bg-neutral-900/90 text-neutral-100 backdrop-blur-md">
      <header className="app-drag flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-neutral-200">Settings</span>
        <button
          type="button"
          onClick={() => window.lune.settings.toggle()}
          aria-label="Close settings"
          className="app-no-drag flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
        >
          ✕
        </button>
      </header>
      {children}
    </div>
  );
}

/** A titled group of settings rows. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">{title}</h2>
      {children}
    </section>
  );
}

/** The per-Capability readiness rows (Reasoning / Transcription / Speech) + Repair. */
function ReadinessSection({ readiness }: { readiness: ReadinessRow[] }) {
  const repair = useSettingsStore((state) => state.repair);
  return (
    <Section title="Status">
      <div className="space-y-1.5">
        {readiness.map((row) => (
          <div key={row.capability} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-2">
              <StatusDot state={row.state} />
              <span className="text-neutral-300">{row.label}</span>
            </span>
            <span className={row.ready ? "text-neutral-500" : "text-amber-300/90"}>{row.detail}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => void repair()}
        className="app-no-drag mt-1 cursor-pointer rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10"
      >
        Repair models
      </button>
    </Section>
  );
}

function StatusDot({ state }: { state: ReadinessRow["state"] }) {
  const color =
    state === "ready" ? "bg-emerald-400" : state === "downloading" ? "bg-sky-400" : "bg-amber-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden />;
}

/** Vendor picker (unkeyed disabled) + Model Slot (shortlist via datalist + free text). */
function ReasoningSection({
  catalog,
  values,
  keyedVendors,
  onSelectVendor,
  onSetModelSlot,
}: {
  catalog: SettingsCatalog;
  values: SettingsValues;
  keyedVendors: SettingsVendorId[];
  onSelectVendor: (vendor: SettingsVendorId) => void;
  onSetModelSlot: (modelSlot: string) => void;
}) {
  const activeVendor = catalog.vendors.find((vendor) => vendor.id === values.reasoning.vendor);
  const [modelDraft, setModelDraft] = useState(values.reasoning.modelSlot);
  // Keep the draft in sync when the applied model changes (e.g. switching Vendor resets it).
  useEffect(() => setModelDraft(values.reasoning.modelSlot), [values.reasoning.modelSlot]);

  return (
    <Section title="Reasoning">
      <div className="flex flex-wrap gap-1.5">
        {catalog.vendors.map((vendor) => {
          const keyed = keyedVendors.includes(vendor.id);
          const active = vendor.id === values.reasoning.vendor;
          return (
            <button
              key={vendor.id}
              type="button"
              disabled={!keyed}
              title={keyed ? undefined : "Add this Vendor's API key below to enable it."}
              onClick={() => onSelectVendor(vendor.id)}
              className={`app-no-drag rounded-lg border px-2.5 py-1.5 text-xs transition ${
                active
                  ? "border-white/25 bg-white/15 text-neutral-100"
                  : keyed
                    ? "cursor-pointer border-white/10 text-neutral-300 hover:bg-white/10"
                    : "border-white/5 text-neutral-600"
              }`}
            >
              {vendor.displayName}
            </button>
          );
        })}
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] text-neutral-500">Model</span>
        <input
          list="reasoning-model-shortlist"
          value={modelDraft}
          onChange={(event) => setModelDraft(event.target.value)}
          onBlur={() => {
            const trimmed = modelDraft.trim();
            if (trimmed.length > 0 && trimmed !== values.reasoning.modelSlot) {
              onSetModelSlot(trimmed);
            } else {
              setModelDraft(values.reasoning.modelSlot);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          placeholder={activeVendor?.defaultModel}
          className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
        />
        <datalist id="reasoning-model-shortlist">
          {(activeVendor?.modelShortlist ?? []).map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>
    </Section>
  );
}

/** The Kokoro Voice picker (all 54). */
function VoiceSection({
  voices,
  voice,
  onSelectVoice,
}: {
  voices: string[];
  voice: string;
  onSelectVoice: (voice: string) => void;
}) {
  return (
    <Section title="Voice">
      <select
        value={voice}
        onChange={(event) => onSelectVoice(event.target.value)}
        className="app-no-drag w-full cursor-pointer rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 focus:border-white/25 focus:outline-none"
      >
        {voices.map((name) => (
          <option key={name} value={name} className="bg-neutral-900">
            {name}
          </option>
        ))}
      </select>
    </Section>
  );
}

/** The push-to-talk hotkey recorder: capture a chord, validate it, apply the canonical token. */
function HotkeySection({ hotkey, onChange }: { hotkey: string; onChange: (hotkey: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (recording) {
      buttonRef.current?.focus();
    }
  }, [recording]);

  const display = useMemo(() => displayHotkeyToken(hotkey), [hotkey]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!recording) {
      return;
    }
    event.preventDefault();
    if (event.key === "Escape") {
      setRecording(false);
      setHint(null);
      return;
    }
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("control");
    if (event.altKey) modifiers.push("alt");
    if (event.shiftKey) modifiers.push("shift");
    if (event.metaKey) modifiers.push("meta");
    const isModifierKey = ["Control", "Alt", "Shift", "Meta"].includes(event.key);
    const parts = [...modifiers];
    if (!isModifierKey) {
      parts.push(event.key === " " ? "Space" : event.key);
    }
    const token = parts.join("+");

    const validation = validateHotkeyToken(token);
    if (validation.ok) {
      onChange(validation.token);
      setRecording(false);
      setHint(null);
    } else {
      // Keep listening; explain why this combo can't be used (rejected gracefully).
      setHint(validation.reason);
    }
  }

  return (
    <Section title="Push-to-talk hotkey">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-neutral-300">{recording ? "Press a key combo…" : display}</span>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => {
            setRecording((value) => !value);
            setHint(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => setRecording(false)}
          className={`app-no-drag cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition ${
            recording
              ? "border-sky-400/50 bg-sky-400/10 text-sky-200"
              : "border-white/10 text-neutral-300 hover:bg-white/10"
          }`}
        >
          {recording ? "Recording" : "Change"}
        </button>
      </div>
      {hint !== null && <p className="text-[11px] text-amber-300/90">{hint}</p>}
    </Section>
  );
}

/** A labeled on/off toggle row (the caller wraps it in whatever Section it belongs to). */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>
        <span className="block text-xs text-neutral-300">{label}</span>
        <span className="block text-[11px] text-neutral-500">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`app-no-drag relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition ${
          checked ? "bg-emerald-500/80" : "bg-white/15"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? "left-4" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/** Per-Vendor secure key entry: enter to save, clear to remove. Never shows a stored key. */
function ApiKeysSection({
  catalog,
  keyedVendors,
}: {
  catalog: SettingsCatalog;
  keyedVendors: SettingsVendorId[];
}) {
  return (
    <Section title="API keys">
      <p className="text-[11px] text-neutral-500">
        Stored in your OS keychain, never in a file. A Vendor unlocks once its key is saved.
      </p>
      <div className="space-y-2">
        {catalog.vendors.map((vendor) => (
          <ApiKeyRow key={vendor.id} vendorId={vendor.id} displayName={vendor.displayName} keyed={keyedVendors.includes(vendor.id)} />
        ))}
      </div>
    </Section>
  );
}

function ApiKeyRow({
  vendorId,
  displayName,
  keyed,
}: {
  vendorId: SettingsVendorId;
  displayName: string;
  keyed: boolean;
}) {
  const setKey = useSettingsStore((state) => state.setKey);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = draft.trim();
    if (value.length === 0 || busy) {
      return;
    }
    setBusy(true);
    try {
      await setKey(vendorId, value);
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await setKey(vendorId, "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-neutral-300">{displayName}</span>
        {keyed && <span className="text-[10px] uppercase tracking-wider text-emerald-400/90">Saved</span>}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submit();
            }
          }}
          placeholder={keyed ? "Enter a new key to replace" : "Paste API key"}
          className="app-no-drag flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || draft.trim().length === 0}
          className="app-no-drag cursor-pointer rounded-lg bg-white/15 px-3 py-2 text-xs text-neutral-100 transition hover:bg-white/25 disabled:cursor-default disabled:opacity-40"
        >
          Save
        </button>
        {keyed && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="app-no-drag cursor-pointer rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-400 transition hover:bg-white/10"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
