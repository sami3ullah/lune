import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "./settingsStore";
import { Combobox } from "./Combobox";
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
          onSelectModel={(vendor, modelSlot) => applyValues({ reasoning: { vendor, modelSlot } })}
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
      </div>
    </Shell>
  );
}

/** The window chrome: draggable header + close, matching the Chat Panel. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden border border-white/10 bg-neutral-900 text-neutral-100">
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

/**
 * The Reasoning section: one card per Vendor, each holding its secure key entry and -
 * once keyed - a live model picker right below the key (so choosing a model never means
 * scrolling to a separate section). Adding a key is live-validated with a cheap test call
 * (the same check onboarding runs); picking a model both routes to that Vendor and sets
 * its Model Slot, so the model list you see always belongs to the Vendor you're editing.
 * The one active Vendor is the one Lune answers with.
 */
function ReasoningSection({
  catalog,
  values,
  keyedVendors,
  onSelectModel,
}: {
  catalog: SettingsCatalog;
  values: SettingsValues;
  keyedVendors: SettingsVendorId[];
  /** Route to `vendor` and answer with `modelSlot` from the next turn on. */
  onSelectModel: (vendor: SettingsVendorId, modelSlot: string) => void;
}) {
  return (
    <Section title="Reasoning">
      <p className="text-[11px] text-neutral-500">
        Lune thinks with your own API key, stored in your OS keychain (never in a file). Connect a Vendor, then pick
        the model Lune should answer with - the active Vendor is the one it uses.
      </p>
      <div className="space-y-2.5">
        {catalog.vendors.map((vendor) => (
          <VendorCard
            key={vendor.id}
            vendor={vendor}
            keyed={keyedVendors.includes(vendor.id)}
            active={vendor.id === values.reasoning.vendor}
            activeModelSlot={values.reasoning.modelSlot}
            onSelectModel={(modelSlot) => onSelectModel(vendor.id, modelSlot)}
          />
        ))}
      </div>
    </Section>
  );
}

/**
 * One Vendor's card: display name + status, secure key entry (live-validated on save,
 * clearable), and - once keyed - the live model picker. Picking a model here makes this
 * Vendor active with that model.
 */
function VendorCard({
  vendor,
  keyed,
  active,
  activeModelSlot,
  onSelectModel,
}: {
  vendor: SettingsCatalog["vendors"][number];
  keyed: boolean;
  active: boolean;
  activeModelSlot: string;
  onSelectModel: (modelSlot: string) => void;
}) {
  const validateKey = useSettingsStore((state) => state.validateKey);
  const clearKey = useSettingsStore((state) => state.clearKey);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const value = draft.trim();
    if (value.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await validateKey(vendor.id, value);
      if (result.ok) {
        setDraft("");
      } else {
        setError(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await clearKey(vendor.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`rounded-xl border p-3 transition ${
        active ? "border-white/25 bg-white/[0.06]" : "border-white/10 bg-black/20"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm text-neutral-200">{vendor.displayName}</span>
        {active ? (
          <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300/90">
            Active
          </span>
        ) : keyed ? (
          <button
            type="button"
            onClick={() => onSelectModel(vendor.defaultModel)}
            className="app-no-drag cursor-pointer rounded-full border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300 transition hover:bg-white/10"
          >
            Use
          </button>
        ) : (
          <span className="text-[10px] uppercase tracking-wider text-neutral-600">No key</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="password"
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
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
          {busy ? "Checking…" : keyed ? "Replace" : "Connect"}
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
      {error !== null && <p className="mt-2 text-[11px] leading-snug text-amber-300/90">{error}</p>}

      {keyed && (
        <VendorModelPicker
          vendor={vendor}
          selectedModel={active ? activeModelSlot : vendor.defaultModel}
          onSelectModel={onSelectModel}
        />
      )}
    </div>
  );
}

/**
 * The per-Vendor model picker: a free-text field whose suggestions are the Vendor's live
 * models, fetched from the Vendor's API when the card first shows (so the list tracks what
 * the Vendor currently serves rather than a hardcoded shortlist). Free text is still
 * allowed for a model not in the list; committing a value routes to this Vendor.
 */
function VendorModelPicker({
  vendor,
  selectedModel,
  onSelectModel,
}: {
  vendor: SettingsCatalog["vendors"][number];
  selectedModel: string;
  onSelectModel: (modelSlot: string) => void;
}) {
  const models = useSettingsStore((state) => state.models[vendor.id]);
  const fetchModels = useSettingsStore((state) => state.fetchModels);

  // Load the Vendor's live models once the card is shown; refetch on an explicit retry.
  useEffect(() => {
    if (models === undefined) {
      void fetchModels(vendor.id);
    }
  }, [models, fetchModels, vendor.id]);

  // The live list when available, else the curated shortlist (offline / not-yet-fetched).
  const modelIds = models?.list.length ? models.list : [...vendor.modelShortlist];
  const options = modelIds.map((id) => ({ value: id, label: id }));

  return (
    <div className="mt-2.5">
      <p className="mb-1 text-[11px] text-neutral-500">Model</p>
      <Combobox
        value={selectedModel}
        options={options}
        onCommit={onSelectModel}
        placeholder={vendor.defaultModel}
        allowCustom
        hint={models?.loading === true ? "Loading models…" : undefined}
        emptyLabel="No matching model - type a model id to use it"
      />
      {models?.error != null && (
        <p className="mt-1 text-[11px] leading-snug text-amber-300/90">
          {models.error}{" "}
          <button
            type="button"
            onClick={() => void fetchModels(vendor.id)}
            className="app-no-drag cursor-pointer text-sky-300/90 underline-offset-2 transition hover:text-sky-200 hover:underline"
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * The accent each Kokoro voice-code language prefix maps to (the first letter of the
 * `<lang><gender>_<name>` code, e.g. the "a" in "af_bella").
 */
const VOICE_ACCENTS: Record<string, string> = {
  a: "American",
  b: "British",
  j: "Japanese",
  z: "Mandarin",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  p: "Portuguese",
};

/** A friendly label + gender/accent for one Kokoro voice code (e.g. "af_bella"). */
function describeVoice(code: string): {
  code: string;
  label: string;
  /** "f" or "m" - females sort first. */
  gender: string;
  accent: string;
  name: string;
} {
  const [prefix = "", rawName = ""] = code.split("_");
  const accent = VOICE_ACCENTS[prefix[0] ?? ""] ?? "Other";
  const gender = prefix[1] === "m" ? "m" : "f";
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  return {
    code,
    label: `${name} - ${accent} ${gender === "m" ? "Male" : "Female"}`,
    gender,
    accent,
    name,
  };
}

/**
 * The Kokoro Voice picker (all 54), shown with friendly full names ("Bella - American
 * Female") rather than raw codes, and ordered females first then males (then by accent
 * and name) so the list is easy to scan.
 */
function VoiceSection({
  voices,
  voice,
  onSelectVoice,
}: {
  voices: string[];
  voice: string;
  onSelectVoice: (voice: string) => void;
}) {
  const orderedVoices = voices
    .map(describeVoice)
    .sort((a, b) => {
      if (a.gender !== b.gender) {
        return a.gender === "f" ? -1 : 1;
      }
      if (a.accent !== b.accent) {
        return a.accent.localeCompare(b.accent);
      }
      return a.name.localeCompare(b.name);
    });
  return (
    <Section title="Voice">
      <Combobox
        value={voice}
        options={orderedVoices.map(({ code, label }) => ({ value: code, label }))}
        onCommit={onSelectVoice}
      />
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

