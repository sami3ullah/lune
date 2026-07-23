import { useEffect } from "react";
import { useScreenAccessStore, type RendererScreenPermissionState } from "./screenAccessStore";

// The Screen Recording permission surface in the Pill menu (ticket 05). Lune sees the
// screen only with this macOS permission, so the flow is explained here rather than
// left to a silent failure: the section polls the live state while open, prompts on
// request, and surfaces the macOS relaunch-if-needed case with a one-click relaunch.
// A fuller onboarding step owns this later (ticket 14); this is its minimal home now.

/** How often to re-read the permission state while the menu is open, in ms. */
const PERMISSION_POLL_INTERVAL_MS = 1500;

/** A colored status dot + human label for each permission state. */
const STATUS_PRESENTATION: Record<
  RendererScreenPermissionState,
  { dotClassName: string; label: string }
> = {
  unknown: { dotClassName: "bg-neutral-500", label: "Checking screen access..." },
  granted: { dotClassName: "bg-emerald-400", label: "Screen access on" },
  "not-determined": { dotClassName: "bg-amber-400", label: "Screen access needed" },
  denied: { dotClassName: "bg-rose-400", label: "Screen access blocked" },
  "granted-needs-relaunch": { dotClassName: "bg-amber-400", label: "Relaunch to finish" },
};

export function ScreenAccessSection() {
  const permissionState = useScreenAccessStore((state) => state.permissionState);
  const isRequesting = useScreenAccessStore((state) => state.isRequesting);
  const refresh = useScreenAccessStore((state) => state.refresh);
  const request = useScreenAccessStore((state) => state.request);
  const relaunch = useScreenAccessStore((state) => state.relaunch);

  // Poll while the section is mounted (the menu is open) so a grant made in System
  // Settings, or the needs-relaunch tell, shows up live. Stop once fully granted -
  // there is nothing left to watch for.
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
      <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">Screen access</p>
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-300">
        <span className={`h-2 w-2 shrink-0 rounded-full ${presentation.dotClassName}`} />
        <span>{presentation.label}</span>
      </div>

      {permissionState === "not-determined" && (
        <ActionRow
          hint="Let Lune see your screen to answer questions about it."
          buttonLabel={isRequesting ? "Requesting..." : "Grant screen access"}
          disabled={isRequesting}
          onClick={() => void request()}
        />
      )}

      {permissionState === "denied" && (
        <ActionRow
          hint="Enable Lune under System Settings > Privacy & Security > Screen Recording, then try again."
          buttonLabel={isRequesting ? "Checking..." : "Try again"}
          disabled={isRequesting}
          onClick={() => void request()}
        />
      )}

      {permissionState === "granted-needs-relaunch" && (
        <ActionRow
          hint="Access granted. macOS needs Lune to relaunch before it can capture."
          buttonLabel="Relaunch Lune"
          disabled={false}
          onClick={relaunch}
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
