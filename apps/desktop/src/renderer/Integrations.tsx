import { useEffect, useMemo, useState } from "react";
import { useIntegrationsStore } from "./integrationsStore";
import type { CredentialField, Integration, IntegrationPreset, IntegrationStatus } from "../ipc/integrations";

// The Integrations surface (M6-02): the window opened from the Pill where the user connects
// apps that give Lune's Task Agents more tools. It is built for a non-technical user - add an
// app in one click, sign in with a browser button, or follow step-by-step guidance to paste a
// value - and it shows, plainly, whether each app is connected, needs attention, or is off,
// with the tools it brings. It shares the Pill/Settings/Skills design language and is its own
// window; every change applies immediately and takes effect on the next Task Agent run.

export function Integrations() {
  const loaded = useIntegrationsStore((state) => state.loaded);
  const presets = useIntegrationsStore((state) => state.presets);
  const integrations = useIntegrationsStore((state) => state.integrations);
  const load = useIntegrationsStore((state) => state.load);
  const subscribe = useIntegrationsStore((state) => state.subscribe);

  useEffect(() => {
    void load();
    // Live status pushes keep the cards current as servers connect, go ready, or drop.
    return subscribe();
  }, [load, subscribe]);

  const available = useMemo(() => presets.filter((preset) => !preset.added), [presets]);
  const connectedCount = useMemo(
    () => integrations.filter((integration) => integration.status === "ready").length,
    [integrations],
  );

  if (!loaded) {
    return (
      <Shell>
        <p className="px-4 py-6 text-center text-xs text-neutral-500">Loading integrations…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <ConnectedBanner connectedCount={connectedCount} />

        <Section title="Your apps">
          <p className="text-[11px] leading-snug text-neutral-500">
            Connected apps give Lune more it can do for you - play music, update a sheet, search your notes.
          </p>
          {integrations.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-neutral-600">
              No apps connected yet. Add one below.
            </p>
          ) : (
            <div className="space-y-2.5">
              {integrations.map((integration) => (
                <IntegrationCard key={integration.id} integration={integration} />
              ))}
            </div>
          )}
        </Section>

        {available.length > 0 && (
          <Section title="Add an app">
            <div className="space-y-2.5">
              {available.map((preset) => (
                <PresetCard key={preset.id} preset={preset} />
              ))}
            </div>
          </Section>
        )}

        <AddCustomServer />
      </div>
    </Shell>
  );
}

/** The window chrome: draggable header + close, matching Settings and Skills. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden border border-white/10 bg-neutral-900 text-neutral-100">
      <header className="app-drag flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-neutral-200">Integrations</span>
        <button
          type="button"
          onClick={() => window.lune.integrations.toggle()}
          aria-label="Close integrations"
          className="app-no-drag flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
        >
          ✕
        </button>
      </header>
      {children}
    </div>
  );
}

/** A titled group of rows (same heading style as Settings and Skills). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">{title}</h2>
      {children}
    </section>
  );
}

/** The at-a-glance line: how many apps are connected and giving Lune tools right now. */
function ConnectedBanner({ connectedCount }: { connectedCount: number }) {
  const line =
    connectedCount === 0
      ? "No apps are connected yet."
      : `${connectedCount} ${connectedCount === 1 ? "app is" : "apps are"} connected and giving Lune extra tools.`;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${connectedCount > 0 ? "bg-emerald-400" : "bg-white/20"}`}
        aria-hidden
      />
      <span className="text-xs text-neutral-300">{line}</span>
    </div>
  );
}

/** How each status reads to the user: a dot colour and a plain-language label. */
function statusPresentation(status: IntegrationStatus): { dot: string; label: string; tone: string } {
  switch (status) {
    case "ready":
      return { dot: "bg-emerald-400", label: "Connected", tone: "text-emerald-300/90" };
    case "connecting":
      return { dot: "bg-sky-400", label: "Connecting…", tone: "text-sky-300/90" };
    case "auth-expired":
      return { dot: "bg-amber-400", label: "Needs attention", tone: "text-amber-300/90" };
    case "error":
      return { dot: "bg-red-400", label: "Not working", tone: "text-red-300/90" };
    case "disabled":
      return { dot: "bg-white/25", label: "Off", tone: "text-neutral-400" };
  }
}

/**
 * One configured integration: its name, live status and tools, an on/off toggle, whatever it
 * needs to authenticate (a Connect button for OAuth, guided fields for credentials), and a
 * Remove action.
 */
function IntegrationCard({ integration }: { integration: Integration }) {
  const setEnabled = useIntegrationsStore((state) => state.setEnabled);
  const remove = useIntegrationsStore((state) => state.remove);
  const refresh = useIntegrationsStore((state) => state.refresh);
  const [busy, setBusy] = useState(false);

  const presentation = statusPresentation(integration.status);
  const connected = integration.status === "ready";
  const needsAttention = integration.status === "auth-expired" || integration.status === "error";

  return (
    <div
      className={`rounded-xl border p-3 transition ${
        connected ? "border-emerald-400/30 bg-emerald-400/[0.06]" : "border-white/10 bg-black/20"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${presentation.dot}`} aria-hidden />
        <span className="text-sm text-neutral-200">{integration.displayName}</span>
        <span className={`text-[10px] uppercase tracking-wider ${presentation.tone}`}>{presentation.label}</span>
        <div className="ml-auto shrink-0">
          <Toggle
            checked={integration.enabled}
            label={`Turn ${integration.displayName} ${integration.enabled ? "off" : "on"}`}
            onChange={(enabled) => void setEnabled(integration.id, enabled)}
          />
        </div>
      </div>

      <p className="text-[11px] leading-snug text-neutral-500">{integration.description}</p>

      {integration.error !== undefined && needsAttention && (
        <p className={`mt-2 text-[11px] leading-snug ${presentation.tone}`}>{integration.error}</p>
      )}

      {integration.enabled && integration.authKind === "oauth" && !connected && (
        <ConnectButton integration={integration} />
      )}

      {integration.enabled && integration.authKind === "credentials" && (
        <CredentialsForm integration={integration} />
      )}

      {connected && integration.tools.length > 0 && <ToolList integration={integration} />}

      <div className="mt-2.5 flex items-center gap-2">
        {integration.status === "error" && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await refresh(integration.id);
              } finally {
                setBusy(false);
              }
            }}
            className="app-no-drag cursor-pointer rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
          >
            Retry
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await remove(integration.id);
            } finally {
              setBusy(false);
            }
          }}
          className="app-no-drag ml-auto cursor-pointer rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-400 transition hover:bg-white/10 hover:text-amber-300/90 disabled:opacity-40"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/** The OAuth one-click sign-in: opens the browser and waits, reporting a failure inline. */
function ConnectButton({ integration }: { integration: Integration }) {
  const startAuth = useIntegrationsStore((state) => state.startAuth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = integration.authorized ? "Reconnect" : "Connect";

  return (
    <div className="mt-2.5">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await startAuth(integration.id);
            if (!result.ok) {
              setError(result.reason ?? "Sign-in did not complete.");
            }
          } finally {
            setBusy(false);
          }
        }}
        className="app-no-drag cursor-pointer rounded-lg bg-emerald-500/80 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Waiting for sign-in…" : `${label} with your browser`}
      </button>
      {error !== null && <p className="mt-1.5 text-[11px] leading-snug text-amber-300/90">{error}</p>}
    </div>
  );
}

/**
 * The guided credential form: one field per value the app needs, each with plain-language help
 * and (when available) a link to where the user gets it. Secrets are masked. Only fields the
 * user actually fills are sent, so saving never wipes a value left blank.
 */
function CredentialsForm({ integration }: { integration: Integration }) {
  const setCredentials = useIntegrationsStore((state) => state.setCredentials);
  // Show the form open when nothing is provided yet; otherwise offer to update.
  const [open, setOpen] = useState(integration.providedCredentialKeys.length === 0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const allProvided = integration.credentialFields
    .filter((field) => field.required)
    .every((field) => integration.providedCredentialKeys.includes(field.key));

  if (!open) {
    return (
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-[11px] text-neutral-500">
          {allProvided ? "Details saved." : "Some details are still needed."}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="app-no-drag cursor-pointer rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-white/10"
        >
          {allProvided ? "Update details" : "Add details"}
        </button>
      </div>
    );
  }

  async function submit() {
    const filled: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim().length > 0) {
        filled[key] = value.trim();
      }
    }
    if (Object.keys(filled).length === 0) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await setCredentials(integration.id, filled);
      setValues({});
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 space-y-2.5 rounded-lg border border-white/10 bg-black/30 p-3">
      {integration.credentialFields.map((field) => (
        <CredentialInput
          key={field.key}
          field={field}
          provided={integration.providedCredentialKeys.includes(field.key)}
          value={values[field.key] ?? ""}
          onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
        />
      ))}
      <div className="flex items-center justify-end gap-2">
        {integration.providedCredentialKeys.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setValues({});
              setOpen(false);
            }}
            className="app-no-drag cursor-pointer rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-400 transition hover:bg-white/10"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="app-no-drag cursor-pointer rounded-lg bg-white/15 px-3 py-1.5 text-xs text-neutral-100 transition hover:bg-white/25 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** One credential field: label, the step-by-step help, an optional docs link, and the input. */
function CredentialInput({
  field,
  provided,
  value,
  onChange,
}: {
  field: CredentialField;
  provided: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-medium text-neutral-300">{field.label}</label>
        {provided && (
          <span className="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300/90">
            Saved
          </span>
        )}
      </div>
      <p className="text-[11px] leading-snug text-neutral-500">{field.help}</p>
      {field.docsUrl !== undefined && (
        <button
          type="button"
          onClick={() => void window.lune.integrations.openDocs(field.docsUrl!)}
          className="app-no-drag cursor-pointer text-[11px] text-sky-300/90 underline underline-offset-2 hover:text-sky-200"
        >
          Open the page to get this →
        </button>
      )}
      <input
        type={field.secret ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={provided ? "•••••• (leave blank to keep)" : field.placeholder}
        className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
      />
    </div>
  );
}

/** The tools a connected app brings, as small chips (what Lune can now do with it). */
function ToolList({ integration }: { integration: Integration }) {
  return (
    <div className="mt-2.5">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
        {integration.toolCount} {integration.toolCount === 1 ? "tool" : "tools"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {integration.tools.map((tool) => (
          <span key={tool.name} className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] text-neutral-300">
            {tool.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One addable app in the catalog: what it does, what setup involves, and an Add button. */
function PresetCard({ preset }: { preset: IntegrationPreset }) {
  const add = useIntegrationsStore((state) => state.add);
  const [busy, setBusy] = useState(false);

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm text-neutral-200">{preset.displayName}</span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await add({ source: "preset", presetId: preset.id });
            } finally {
              setBusy(false);
            }
          }}
          className="app-no-drag ml-auto cursor-pointer rounded-lg border border-white/15 px-2.5 py-1 text-[11px] text-neutral-200 transition hover:border-white/25 hover:bg-white/10 disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-neutral-500">{preset.description}</p>
      {preset.setupHint !== undefined && (
        <p className="mt-1 text-[11px] leading-snug text-neutral-600">{preset.setupHint}</p>
      )}
    </div>
  );
}

/** The advanced escape hatch: add any MCP server by hand (a local command or a URL). */
function AddCustomServer() {
  const add = useIntegrationsStore((state) => state.add);
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="app-no-drag w-full cursor-pointer rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-xs text-neutral-400 transition hover:border-white/25 hover:bg-white/5 hover:text-neutral-200"
      >
        + Add a custom MCP server
      </button>
    );
  }

  const canSubmit =
    displayName.trim().length > 0 &&
    (kind === "stdio" ? command.trim().length > 0 : /^https?:\/\//i.test(url.trim())) &&
    !busy;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    try {
      const transport =
        kind === "stdio"
          ? {
              kind: "stdio" as const,
              command: command.trim(),
              args: args.trim().length > 0 ? args.trim().split(/\s+/) : undefined,
            }
          : { kind: "http" as const, url: url.trim() };
      await add({ source: "custom", displayName: displayName.trim(), transport });
      setOpen(false);
      setDisplayName("");
      setCommand("");
      setArgs("");
      setUrl("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-white/15 bg-black/30 p-3">
      <p className="text-[11px] leading-snug text-neutral-500">
        Advanced: connect any MCP server. Use a command for a local server, or a URL for a remote one.
      </p>
      <input
        type="text"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        placeholder="Name, e.g. My server"
        className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
      />
      <div className="flex gap-1.5">
        {(["stdio", "http"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(option)}
            className={`app-no-drag cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] transition ${
              kind === option
                ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-200"
                : "border-white/10 text-neutral-400 hover:bg-white/10"
            }`}
          >
            {option === "stdio" ? "Local command" : "Remote URL"}
          </button>
        ))}
      </div>
      {kind === "stdio" ? (
        <>
          <input
            type="text"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Command, e.g. npx"
            className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
          />
          <input
            type="text"
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder="Arguments, e.g. -y some-mcp-server"
            className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
          />
        </>
      ) : (
        <input
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/mcp"
          className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
        />
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="app-no-drag cursor-pointer rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-400 transition hover:bg-white/10"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="app-no-drag cursor-pointer rounded-lg bg-white/15 px-3 py-1.5 text-xs text-neutral-100 transition hover:bg-white/25 disabled:cursor-default disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add server"}
        </button>
      </div>
    </div>
  );
}

/** A small on/off switch, matching the Settings/Skills toggle (emerald when on). */
function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`app-no-drag relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition ${
        checked ? "bg-emerald-500/80" : "bg-white/15"
      }`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-4" : "left-0.5"}`} />
    </button>
  );
}
