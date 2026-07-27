import { useCallback, useEffect, useMemo, useState } from "react";
import { ONBOARDING_STEPS, useOnboardingStore, type OnboardingStep } from "./onboardingStore";
import { useScreenAccessStore, type RendererScreenPermissionState } from "./screenAccessStore";
import { useMicAccessStore, type RendererMicPermissionState } from "./micAccessStore";
import {
  useAccessibilityAccessStore,
  type RendererAccessibilityPermissionState,
} from "./accessibilityAccessStore";
import type { SettingsCatalog } from "../ipc/settings";
import { displayHotkeyToken } from "../ipc/hotkey";

// The onboarding surface (ticket 14): the jargon-free first run. Five steps - welcome
// (the silent download has already begun), the mandatory key step (live-validated, "get
// a key" links), the permissions step (mic + screen, live-detected, relaunch handled),
// the download step (remaining progress beside tutorial cards, with text chat already
// usable), and a delightful ready moment prompting the first push-to-talk. It shares the
// Pill/Settings design language and is its own window; completing it is remembered so a
// returning user never sees it again.

/** How often to re-poll the download status while the download step is open, in ms. */
const DOWNLOAD_POLL_MS = 1000;
/** How often to re-poll permission state while the permissions step is open, in ms. */
const PERMISSION_POLL_MS = 1500;

export function Onboarding() {
  const loaded = useOnboardingStore((state) => state.loaded);
  const step = useOnboardingStore((state) => state.step);
  const load = useOnboardingStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell step={step}>
      {!loaded ? (
        <p className="flex-1 px-6 py-10 text-center text-xs text-neutral-500">Loading…</p>
      ) : step === "welcome" ? (
        <WelcomeStep />
      ) : step === "keys" ? (
        <KeysStep />
      ) : step === "permissions" ? (
        <PermissionsStep />
      ) : step === "download" ? (
        <DownloadStep />
      ) : (
        <ReadyStep />
      )}
    </Shell>
  );
}

/** The window chrome: draggable header, a step-progress rail, and the step body. */
function Shell({ step, children }: { step: OnboardingStep; children: React.ReactNode }) {
  const activeIndex = ONBOARDING_STEPS.indexOf(step);
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden border border-white/10 bg-neutral-900/95 text-neutral-100 backdrop-blur-md">
      <header className="app-drag flex items-center justify-between border-b border-white/10 px-5 py-3">
        <span className="text-xs font-medium tracking-wide text-neutral-200">Welcome to Lune</span>
        <div className="flex items-center gap-1.5">
          {ONBOARDING_STEPS.map((candidate, index) => (
            <span
              key={candidate}
              aria-hidden
              className={`h-1.5 rounded-full transition-all ${
                index === activeIndex
                  ? "w-5 bg-neutral-100"
                  : index < activeIndex
                    ? "w-1.5 bg-neutral-400"
                    : "w-1.5 bg-white/15"
              }`}
            />
          ))}
        </div>
      </header>
      {children}
    </div>
  );
}

/** The scrolling body + a pinned footer, the shape every step shares. */
function StepLayout({ body, footer }: { body: React.ReactNode; footer: React.ReactNode }) {
  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-6">{body}</div>
      <footer className="flex items-center justify-between gap-3 border-t border-white/10 px-6 py-4">{footer}</footer>
    </>
  );
}

/** The primary "move forward" button. */
function PrimaryButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="app-no-drag cursor-pointer rounded-xl bg-white px-5 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:cursor-default disabled:bg-white/20 disabled:text-neutral-500"
    >
      {label}
    </button>
  );
}

/** The subtle "go back" button. */
function BackButton() {
  const back = useOnboardingStore((state) => state.back);
  return (
    <button
      type="button"
      onClick={back}
      className="app-no-drag cursor-pointer rounded-xl px-3 py-2 text-sm text-neutral-400 transition hover:text-neutral-100"
    >
      Back
    </button>
  );
}

/** Step 1: what Lune is. The download has already started silently behind this screen. */
function WelcomeStep() {
  const next = useOnboardingStore((state) => state.next);
  // The Farza-style intro video (M3-03) rides alongside the cursor for this step only. It
  // starts when the step mounts and is dismissed when the step advances (unmount cleanup) or
  // is skipped. Skipping flips this flag, which re-runs the effect: the cleanup ends the
  // video and the early return keeps it from restarting while the user lingers on welcome.
  const [introDismissed, setIntroDismissed] = useState(false);
  useEffect(() => {
    if (introDismissed) {
      return;
    }
    window.lune.onboarding.setIntroVideo(true);
    return () => window.lune.onboarding.setIntroVideo(false);
  }, [introDismissed]);

  return (
    <StepLayout
      body={
        <div className="flex h-full flex-col items-center justify-center text-center">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-sky-400/30 to-violet-500/30 text-3xl">
            🌙
          </div>
          <h1 className="text-xl font-semibold text-neutral-50">Meet Lune</h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-neutral-400">
            Lune is an on-screen companion you talk or type to. It sees your screen, answers out
            loud, and points at what it means. Let's get you set up - it takes about a minute, and
            your voice models are already downloading in the background.
          </p>
        </div>
      }
      footer={
        <>
          {introDismissed ? (
            <span />
          ) : (
            <button
              type="button"
              onClick={() => setIntroDismissed(true)}
              className="app-no-drag cursor-pointer rounded-xl px-3 py-2 text-sm text-neutral-400 transition hover:text-neutral-100"
            >
              Skip intro
            </button>
          )}
          <PrimaryButton label="Get started" onClick={next} />
        </>
      }
    />
  );
}

/** Step 2: the mandatory key step - at least one live-validated Vendor. */
function KeysStep() {
  const catalog = useOnboardingStore((state) => state.catalog);
  const keyedVendors = useOnboardingStore((state) => state.keyedVendors);
  const next = useOnboardingStore((state) => state.next);
  const hasKey = keyedVendors.length > 0;

  return (
    <StepLayout
      body={
        <div className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-neutral-50">Connect a reasoning model</h1>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">
              Lune thinks with your own API key. Add at least one - Gemini is the cheapest daily
              driver, but any works. Your key is stored in your OS keychain, never in a file.
            </p>
          </div>
          <div className="space-y-3">
            {(catalog?.vendors ?? []).map((vendor) => (
              <VendorKeyRow
                key={vendor.id}
                vendor={vendor}
                keyed={keyedVendors.includes(vendor.id)}
              />
            ))}
          </div>
        </div>
      }
      footer={
        <>
          <BackButton />
          <PrimaryButton
            label={hasKey ? "Continue" : "Add a key to continue"}
            onClick={next}
            disabled={!hasKey}
          />
        </>
      }
    />
  );
}

/** One Vendor's key field: paste, validate live, and see a specific reason on failure. */
function VendorKeyRow({
  vendor,
  keyed,
}: {
  vendor: SettingsCatalog["vendors"][number];
  keyed: boolean;
}) {
  const validateKey = useOnboardingStore((state) => state.validateKey);
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

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm text-neutral-200">
          {vendor.displayName}
          {keyed && (
            <span className="text-[10px] uppercase tracking-wider text-emerald-400/90">Connected</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => window.lune.onboarding.openGetKeyLink(vendor.id)}
          className="app-no-drag cursor-pointer text-[11px] text-sky-300/90 transition hover:text-sky-200"
        >
          Get a key ↗
        </button>
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
          {busy ? "Checking…" : "Validate"}
        </button>
      </div>
      {error !== null && <p className="mt-2 text-[11px] leading-snug text-amber-300/90">{error}</p>}
    </div>
  );
}

/** Step 3: mic + screen recording, explained and live-detected (relaunch handled). */
function PermissionsStep() {
  const next = useOnboardingStore((state) => state.next);

  const screenState = useScreenAccessStore((state) => state.permissionState);
  const screenRequesting = useScreenAccessStore((state) => state.isRequesting);
  const refreshScreen = useScreenAccessStore((state) => state.refresh);
  const requestScreen = useScreenAccessStore((state) => state.request);
  const relaunch = useScreenAccessStore((state) => state.relaunch);

  const openScreenSettings = useScreenAccessStore((state) => state.openSettings);

  const micState = useMicAccessStore((state) => state.permissionState);
  const micRequesting = useMicAccessStore((state) => state.isRequesting);
  const refreshMic = useMicAccessStore((state) => state.refresh);
  const requestMic = useMicAccessStore((state) => state.request);
  const openMicSettings = useMicAccessStore((state) => state.openSettings);

  const accessibilityState = useAccessibilityAccessStore((state) => state.permissionState);
  const accessibilityRequesting = useAccessibilityAccessStore((state) => state.isRequesting);
  const refreshAccessibility = useAccessibilityAccessStore((state) => state.refresh);
  const requestAccessibility = useAccessibilityAccessStore((state) => state.request);
  const openAccessibilitySettings = useAccessibilityAccessStore((state) => state.openSettings);

  // Poll all three permissions while this step is open so a grant made in System Settings
  // (or the screen needs-relaunch tell) shows up live without a restart. The Accessibility
  // poll is also what tells the main process to start the push-to-talk hook the moment the
  // user enables it.
  useEffect(() => {
    void refreshScreen();
    void refreshMic();
    void refreshAccessibility();
    const timer = setInterval(() => {
      void refreshScreen();
      void refreshMic();
      void refreshAccessibility();
    }, PERMISSION_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshScreen, refreshMic, refreshAccessibility]);

  return (
    <StepLayout
      body={
        <div className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-neutral-50">Grant three permissions</h1>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">
              Lune needs your screen to answer about what you see, your mic to hear you, and
              accessibility to catch your push-to-talk hotkey anywhere. You can always change these
              later in System Settings.
            </p>
          </div>

          <ScreenPermissionCard
            state={screenState}
            requesting={screenRequesting}
            onRequest={() => void requestScreen()}
            onRelaunch={relaunch}
            onOpenSettings={openScreenSettings}
          />
          <MicPermissionCard
            state={micState}
            requesting={micRequesting}
            onRequest={() => void requestMic()}
            onOpenSettings={openMicSettings}
          />
          <AccessibilityPermissionCard
            state={accessibilityState}
            requesting={accessibilityRequesting}
            onRequest={() => void requestAccessibility()}
            onOpenSettings={openAccessibilitySettings}
          />
        </div>
      }
      footer={
        <>
          <BackButton />
          <PrimaryButton label="Continue" onClick={next} />
        </>
      }
    />
  );
}

/** A permission card: status dot + label, an explanation, and the state's one action. */
function PermissionCard({
  title,
  dotClassName,
  label,
  hint,
  action,
}: {
  title: string;
  dotClassName: string;
  label: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm text-neutral-200">{title}</span>
        <span className="flex items-center gap-2 text-xs text-neutral-400">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotClassName}`} />
          {label}
        </span>
      </div>
      {hint !== undefined && <p className="mb-2.5 text-[11px] leading-snug text-neutral-500">{hint}</p>}
      {action}
    </div>
  );
}

/** The state's action button, styled for the permission cards. */
function PermissionButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="app-no-drag w-full cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-white/15 disabled:cursor-default disabled:opacity-50"
    >
      {label}
    </button>
  );
}

const SCREEN_PRESENTATION: Record<RendererScreenPermissionState, { dot: string; label: string }> = {
  unknown: { dot: "bg-neutral-500", label: "Checking…" },
  granted: { dot: "bg-emerald-400", label: "On" },
  "not-determined": { dot: "bg-amber-400", label: "Needed" },
  denied: { dot: "bg-rose-400", label: "Blocked" },
  "granted-needs-relaunch": { dot: "bg-amber-400", label: "Relaunch" },
};

function ScreenPermissionCard({
  state,
  requesting,
  onRequest,
  onRelaunch,
  onOpenSettings,
}: {
  state: RendererScreenPermissionState;
  requesting: boolean;
  onRequest: () => void;
  onRelaunch: () => void;
  onOpenSettings: () => void;
}) {
  const presentation = SCREEN_PRESENTATION[state];
  return (
    <PermissionCard
      title="Screen recording"
      dotClassName={presentation.dot}
      label={presentation.label}
      hint={
        state === "granted"
          ? undefined
          : state === "denied"
            ? // macOS never re-prompts after a denial, so the button opens the pane; the
              // toggle then takes effect and this step detects it on its next poll.
              "Turn on Lune under System Settings › Privacy & Security › Screen Recording - it activates here automatically once enabled."
            : state === "granted-needs-relaunch"
              ? "Access granted. macOS needs Lune to relaunch before it can capture."
              : "Let Lune see your screen to answer questions about it."
      }
      action={
        state === "granted" ? undefined : state === "granted-needs-relaunch" ? (
          <PermissionButton label="Relaunch Lune" onClick={onRelaunch} />
        ) : state === "denied" ? (
          // macOS never re-prompts after a denial, so offer both: attempt a capture
          // (which pops the OS prompt on the very first try in a signed build) and a
          // direct jump to the Settings pane for when the toggle just needs flipping.
          <div className="space-y-1.5">
            <PermissionButton
              label={requesting ? "Checking…" : "Grant screen access"}
              onClick={onRequest}
              disabled={requesting}
            />
            <PermissionButton label="Open System Settings" onClick={onOpenSettings} />
          </div>
        ) : (
          <PermissionButton
            label={requesting ? "Checking…" : "Grant screen access"}
            onClick={onRequest}
            disabled={requesting}
          />
        )
      }
    />
  );
}

const MIC_PRESENTATION: Record<RendererMicPermissionState, { dot: string; label: string }> = {
  unknown: { dot: "bg-neutral-500", label: "Checking…" },
  granted: { dot: "bg-emerald-400", label: "On" },
  "not-determined": { dot: "bg-amber-400", label: "Needed" },
  denied: { dot: "bg-rose-400", label: "Blocked" },
};

function MicPermissionCard({
  state,
  requesting,
  onRequest,
  onOpenSettings,
}: {
  state: RendererMicPermissionState;
  requesting: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
}) {
  const presentation = MIC_PRESENTATION[state];
  return (
    <PermissionCard
      title="Microphone"
      dotClassName={presentation.dot}
      label={presentation.label}
      hint={
        state === "granted"
          ? undefined
          : state === "denied"
            ? "Turn on Lune under System Settings › Privacy & Security › Microphone - it activates here automatically once enabled."
            : "Let Lune hear you so you can hold the hotkey and talk."
      }
      action={
        state === "granted" ? undefined : state === "denied" ? (
          <div className="space-y-1.5">
            <PermissionButton
              label={requesting ? "Checking…" : "Grant mic access"}
              onClick={onRequest}
              disabled={requesting}
            />
            <PermissionButton label="Open System Settings" onClick={onOpenSettings} />
          </div>
        ) : (
          <PermissionButton
            label={requesting ? "Checking…" : "Grant mic access"}
            onClick={onRequest}
            disabled={requesting}
          />
        )
      }
    />
  );
}

const ACCESSIBILITY_PRESENTATION: Record<
  RendererAccessibilityPermissionState,
  { dot: string; label: string }
> = {
  unknown: { dot: "bg-neutral-500", label: "Checking…" },
  granted: { dot: "bg-emerald-400", label: "On" },
  "not-granted": { dot: "bg-amber-400", label: "Needed" },
};

function AccessibilityPermissionCard({
  state,
  requesting,
  onRequest,
  onOpenSettings,
}: {
  state: RendererAccessibilityPermissionState;
  requesting: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
}) {
  const presentation = ACCESSIBILITY_PRESENTATION[state];
  return (
    <PermissionCard
      title="Accessibility"
      dotClassName={presentation.dot}
      label={presentation.label}
      hint={
        state === "granted"
          ? undefined
          : // macOS cannot grant Accessibility inline; the request pops a prompt that
            // routes to System Settings, where the user turns Lune on. This step detects
            // it on its next poll and hold-to-talk goes live with no restart.
            "Let Lune catch your push-to-talk hotkey anywhere. Turn on Lune under System Settings › Privacy & Security › Accessibility - it activates here automatically once enabled."
      }
      action={
        state === "granted" ? undefined : (
          <div className="space-y-1.5">
            <PermissionButton
              label={requesting ? "Waiting…" : "Grant accessibility"}
              onClick={onRequest}
              disabled={requesting}
            />
            <PermissionButton label="Open System Settings" onClick={onOpenSettings} />
          </div>
        )
      }
    />
  );
}

/** Step 4: remaining download progress beside tutorial cards; text chat already works. */
function DownloadStep() {
  const download = useOnboardingStore((state) => state.download);
  const refreshDownload = useOnboardingStore((state) => state.refreshDownload);
  const next = useOnboardingStore((state) => state.next);

  // Poll progress while this step is open so the bar advances live and completion flips.
  useEffect(() => {
    void refreshDownload();
    const timer = setInterval(() => void refreshDownload(), DOWNLOAD_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshDownload]);

  const percent = download?.percent ?? 0;
  const complete = download?.complete ?? false;
  const preflight = download?.preflightFailure;
  // A failed run (a preflight failure, or a mid-download drop after preflight passed)
  // must always be explained with a retry - never a frozen progress bar (story 11).
  const failed = preflight !== undefined || download?.phase === "failed";
  const failureDetail =
    preflight?.detail ?? "The download stopped before it finished. Check your connection and retry.";

  return (
    <StepLayout
      body={
        <div className="space-y-5">
          <div>
            <h1 className="text-lg font-semibold text-neutral-50">
              {complete ? "Your voice models are ready" : "Downloading your voice models"}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">
              Speech and transcription run on your device, so their weights (~2 GB) download once.
              You can start typing to Lune right now while they finish.
            </p>
          </div>

          {failed ? (
            <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-4">
              <p className="text-sm text-rose-200">Download couldn't continue</p>
              <p className="mt-1 text-[11px] leading-snug text-rose-200/80">{failureDetail}</p>
              <button
                type="button"
                onClick={() => window.lune.onboarding.startDownload()}
                className="app-no-drag mt-3 cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-white/15"
              >
                Retry download
              </button>
            </div>
          ) : (
            <ProgressBar percent={percent} complete={complete} />
          )}

          <div className="space-y-2.5">
            <TutorialCard
              icon="⌨️"
              title="Hold to talk"
              body="Hold your push-to-talk hotkey anywhere, speak, and release. Lune hears you and answers out loud."
            />
            <TutorialCard
              icon="🌙"
              title="The Pill is home"
              body="A thin bar floats under your menu bar. Hover it for the Chat Panel, Settings, and quit."
            />
          </div>

          <button
            type="button"
            onClick={() => window.lune.chatPanel.toggle()}
            className="app-no-drag w-full cursor-pointer rounded-xl border border-white/10 px-4 py-2.5 text-sm text-neutral-200 transition hover:bg-white/10"
          >
            Try text chat now →
          </button>
        </div>
      }
      footer={
        <>
          <BackButton />
          {/* The ready moment is gated on Provisioning completing (story 8: "a clear ready
              moment when Provisioning completes"), so voice is genuinely unlocked by the
              time it prompts the first push-to-talk. Text chat is usable meanwhile via the
              button above, so waiting here never blocks the user from the app. */}
          <PrimaryButton
            label={complete ? "Continue" : failed ? "Download stalled" : `Downloading ${percent}%`}
            onClick={next}
            disabled={!complete}
          />
        </>
      }
    />
  );
}

/** The download progress bar, filling to `percent` (or a full green bar when complete). */
function ProgressBar({ percent, complete }: { percent: number; complete: boolean }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-neutral-400">
        <span>{complete ? "Complete" : "Downloading…"}</span>
        <span>{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-all ${complete ? "bg-emerald-400" : "bg-sky-400"}`}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
    </div>
  );
}

/** A small teaching card shown beside the download progress. */
function TutorialCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <span className="text-lg" aria-hidden>
        {icon}
      </span>
      <span>
        <span className="block text-sm text-neutral-200">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">{body}</span>
      </span>
    </div>
  );
}

/** Step 5: the ready moment - prompt the first push-to-talk and finish. */
function ReadyStep() {
  const hotkey = useOnboardingStore((state) => state.hotkey);
  const complete = useOnboardingStore((state) => state.complete);
  const hotkeyDisplay = useMemo(() => displayHotkeyToken(hotkey), [hotkey]);
  const finish = useCallback(() => complete(), [complete]);

  return (
    <StepLayout
      body={
        <div className="flex h-full flex-col items-center justify-center text-center">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-400/30 to-sky-500/30 text-3xl">
            ✨
          </div>
          <h1 className="text-xl font-semibold text-neutral-50">You're all set</h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-neutral-400">
            Try it now: hold{" "}
            <span className="rounded-md border border-white/15 bg-white/10 px-1.5 py-0.5 font-medium text-neutral-100">
              {hotkeyDisplay}
            </span>{" "}
            anywhere, ask something about your screen, and let go. Lune will answer out loud and
            point at what it means.
          </p>
        </div>
      }
      footer={
        <>
          <span />
          <PrimaryButton label="Start using Lune" onClick={finish} />
        </>
      }
    />
  );
}
