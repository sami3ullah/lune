import { useEffect, useRef, useState } from "react";

// A dropdown rendered entirely in the DOM - deliberately NOT a native `<select>` or
// `<input list>`/`<datalist>`. Opening a native popup menu inside Lune's frameless,
// always-on-top windows crashes Chromium's GPU process on macOS (it hard-exits the whole
// app, taking the dev server with it), so every picker in these windows must draw its own
// list. The panel opens in normal flow below the control (no absolute positioning to be
// clipped by the scroll container, no native menu to crash), scrolls internally when the
// list is long, and closes on outside-click or Escape.

/** One selectable row: the stored `value` and the human-facing `label` shown for it. */
export interface ComboboxOption {
  value: string;
  label: string;
}

export function Combobox({
  value,
  options,
  onCommit,
  placeholder,
  allowCustom = false,
  disabled = false,
  hint,
  emptyLabel = "No matches",
}: {
  /** The currently-selected value (the option to highlight / the text to show). */
  value: string;
  /** The list to choose from. */
  options: ComboboxOption[];
  /** Called with the chosen (or typed, when `allowCustom`) value. */
  onCommit: (value: string) => void;
  /** Placeholder for the free-text field (only shown when `allowCustom`). */
  placeholder?: string;
  /** Allow typing a value not in the list (a combobox); otherwise a fixed-list select. */
  allowCustom?: boolean;
  disabled?: boolean;
  /** A short note shown at the top of the open panel (e.g. "Loading models…"). */
  hint?: string;
  /** Text shown when the (filtered) list is empty. */
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // The free-text draft (combobox mode). Kept in sync with the applied value so an edit
  // made elsewhere (e.g. switching which Vendor is active) reflects here.
  const [draft, setDraft] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(value), [value]);

  // Close on a click anywhere outside this control, or on Escape.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  // In combobox mode, filter by what's typed - unless the draft still equals the applied
  // value (i.e. the user just opened it), when the whole list is shown.
  const query = draft.trim().toLowerCase();
  const filtered =
    allowCustom && query.length > 0 && draft !== value
      ? options.filter(
          (option) =>
            option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query),
        )
      : options;

  function choose(next: string): void {
    setDraft(next);
    setOpen(false);
    if (next !== value) {
      onCommit(next);
    }
  }

  /** Commit the typed draft (combobox mode) on Enter/blur; empty or unchanged resets it. */
  function commitDraft(): void {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== value) {
      onCommit(trimmed);
    } else {
      setDraft(value);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      {allowCustom ? (
        <div
          className={`app-no-drag flex items-center rounded-lg border bg-black/30 transition ${
            open ? "border-white/25" : "border-white/10"
          }`}
        >
          <input
            value={draft}
            disabled={disabled}
            onChange={(event) => {
              setDraft(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitDraft();
                setOpen(false);
              }
            }}
            onBlur={commitDraft}
            placeholder={placeholder}
            className="flex-1 bg-transparent px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          <Caret open={open} onClick={() => setOpen((wasOpen) => !wasOpen)} disabled={disabled} />
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className={`app-no-drag flex w-full items-center justify-between gap-2 rounded-lg border bg-black/30 px-3 py-2 text-left text-xs text-neutral-100 transition ${
            open ? "border-white/25" : "border-white/10"
          } disabled:cursor-default disabled:opacity-40`}
        >
          <span className="truncate">{selectedLabel}</span>
          <Chevron open={open} />
        </button>
      )}

      {open && (
        <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-white/10 bg-neutral-800 py-1 shadow-lg">
          {hint !== undefined && (
            <p className="px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">{hint}</p>
          )}
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-neutral-500">{emptyLabel}</p>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                // mousedown (not click) with preventDefault so choosing from the list never
                // first blurs the input and commits the stale typed draft.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option.value);
                }}
                className={`block w-full cursor-pointer px-3 py-1.5 text-left text-xs transition hover:bg-white/10 ${
                  option.value === value ? "text-neutral-100" : "text-neutral-300"
                }`}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** The caret button beside the combobox input; toggles the panel. */
function Caret({ open, onClick, disabled }: { open: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      aria-label="Toggle options"
      className="flex shrink-0 items-center px-2 py-2 text-neutral-400 transition hover:text-neutral-100"
    >
      <Chevron open={open} />
    </button>
  );
}

/** A small chevron that flips when the panel is open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
