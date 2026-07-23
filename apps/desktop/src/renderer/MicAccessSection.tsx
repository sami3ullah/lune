import { useEffect } from "react";
import { useMicAccessStore, type RendererMicPermissionState } from "./micAccessStore";

// The microphone permission surface in the Pill menu (ticket 11). Push-to-talk needs
// the mic, so the flow is explained here rather than left to a silent failure: the
// section polls the live state while open, and prompts on request. It mirrors the Screen
// access section; a fuller onboarding step owns this later (ticket 14), and this is its
// minimal home now so the hold-to-talk gesture has a clean grant path.

/** How often to re-read the permission state while the menu is open, in ms. */
const PERMISSION_POLL_INTERVAL_MS = 1500;

/** A colored status dot + human label for each permission state. */
const STATUS_PRESENTATION: Record<
  RendererMicPermissionState,
  { dotClassName: string; label: string }
> = {
  unknown: { dotClassName: "bg-neutral-500", label: "Checking mic access..." },
  granted: { dotClassName: "bg-emerald-400", label: "Mic access on" },
  "not-determined": { dotClassName: "bg-amber-400", label: "Mic access needed" },
  denied: { dotClassName: "bg-rose-400", label: "Mic access blocked" },
};

export function MicAccessSection() {
  const permissionState = useMicAccessStore((state) => state.permissionState);
  const isRequesting = useMicAccessStore((state) => state.isRequesting);
  const refresh = useMicAccessStore((state) => state.refresh);
  const request = useMicAccessStore((state) => state.request);
  const openSettings = useMicAccessStore((state) => state.openSettings);

  // Poll while the section is mounted (the menu is open) so a grant made in System
  // Settings shows up live. Stop once granted - there is nothing left to watch for.
  useEffect(() => {
    void refresh();
    if (permissionState === "granted") {
      return;
    }
    const pollTimer = setInterval(() => void refresh(), PERMISSION_POLL_INTERVAL_MS);
    return () => clearInterval(pollTimer);
  }, [refresh, permissionState]);

  const presentation = STATUS_PRESENTATION[permissionState];

  return (
    <div className="mt-1.5 border-t border-white/10 pt-1.5">
      <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">Microphone</p>
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-300">
        <span className={`h-2 w-2 shrink-0 rounded-full ${presentation.dotClassName}`} />
        <span>{presentation.label}</span>
      </div>

      {permissionState === "not-determined" && (
        <ActionRow
          hint="Let Lune hear you so you can hold the hotkey and talk."
          buttonLabel={isRequesting ? "Requesting..." : "Grant mic access"}
          disabled={isRequesting}
          onClick={() => void request()}
        />
      )}

      {permissionState === "denied" && (
        <ActionRow
          hint="Turn on Lune under System Settings > Privacy & Security > Microphone - it activates here automatically once enabled."
          buttonLabel="Open System Settings"
          disabled={false}
          onClick={openSettings}
        />
      )}
    </div>
  );
}

/** A short explanation plus a single action button, the shape every non-granted state uses. */
function ActionRow({
  hint,
  buttonLabel,
  disabled,
  onClick,
}: {
  hint: string;
  buttonLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="px-3 pb-1 pt-0.5">
      <p className="pb-1.5 text-[11px] leading-snug text-neutral-500">{hint}</p>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="app-no-drag w-full cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-white/15 disabled:cursor-default disabled:opacity-50"
      >
        {buttonLabel}
      </button>
    </div>
  );
}
