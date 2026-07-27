import { useEffect, useMemo, useState } from "react";
import { useSkillsStore } from "./skillsStore";
import type { SkillValue } from "../ipc/skills";

// The Skills surface (M4-02): the tab opened from the Pill where the user browses the
// predefined starters, writes their own Skills, toggles each on or off, and sees which are
// shaping Lune's answers right now. It shares the Pill/Settings design language (dark,
// rounded, bordered) and is its own window. Every change applies immediately - a toggle,
// a create, an edit, or a delete persists and takes effect on the next turn, matching the
// no-Save-button feel of Settings.
//
// "Which Skills shaped the current answer" is the set that is turned on: an enabled Skill
// is injected into every turn until turned off, so the active set IS what shaped the last
// answer and will shape the next. The banner counts them and each active card is badged.

export function Skills() {
  const loaded = useSkillsStore((state) => state.loaded);
  const skills = useSkillsStore((state) => state.skills);
  const load = useSkillsStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  const predefined = useMemo(() => skills.filter((skill) => skill.source === "predefined"), [skills]);
  const userSkills = useMemo(() => skills.filter((skill) => skill.source === "user"), [skills]);
  const activeCount = useMemo(() => skills.filter((skill) => skill.enabled).length, [skills]);

  if (!loaded) {
    return (
      <Shell>
        <p className="px-4 py-6 text-center text-xs text-neutral-500">Loading skills…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <ActiveBanner activeCount={activeCount} />

        <Section title="Your skills">
          <p className="text-[11px] leading-snug text-neutral-500">
            Skills are reusable instructions that shape how Lune answers. Turn one on and it guides every reply until
            you turn it off.
          </p>
          {userSkills.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-neutral-600">
              No skills of your own yet. Add one below.
            </p>
          ) : (
            <div className="space-y-2.5">
              {userSkills.map((skill) => (
                <SkillCard key={skill.id} skill={skill} />
              ))}
            </div>
          )}
          <AddSkill />
        </Section>

        <Section title="Starter skills">
          <p className="text-[11px] leading-snug text-neutral-500">
            A few we made for you. Toggle any on; they stay put so you always have a starting point.
          </p>
          <div className="space-y-2.5">
            {predefined.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </Section>
      </div>
    </Shell>
  );
}

/** The window chrome: draggable header + close, matching Settings and the Chat Panel. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden border border-white/10 bg-neutral-900 text-neutral-100">
      <header className="app-drag flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-neutral-200">Skills</span>
        <button
          type="button"
          onClick={() => window.lune.skills.toggle()}
          aria-label="Close skills"
          className="app-no-drag flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
        >
          ✕
        </button>
      </header>
      {children}
    </div>
  );
}

/** A titled group of rows (same heading style as Settings). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">{title}</h2>
      {children}
    </section>
  );
}

/** The at-a-glance line: how many Skills are shaping Lune's answers right now. */
function ActiveBanner({ activeCount }: { activeCount: number }) {
  const shaping =
    activeCount === 0
      ? "No skills are shaping Lune's answers yet."
      : `${activeCount} ${activeCount === 1 ? "skill is" : "skills are"} shaping Lune's answers.`;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${activeCount > 0 ? "bg-emerald-400" : "bg-white/20"}`}
        aria-hidden
      />
      <span className="text-xs text-neutral-300">{shaping}</span>
    </div>
  );
}

/**
 * One Skill: its title, instructions, and an on/off toggle. A predefined starter carries a
 * "Starter" badge and can only be toggled; the user's own Skills can also be edited and
 * deleted (editing opens an inline form in place of the card body).
 */
function SkillCard({ skill }: { skill: SkillValue }) {
  const setEnabled = useSkillsStore((state) => state.setEnabled);
  const update = useSkillsStore((state) => state.update);
  const remove = useSkillsStore((state) => state.remove);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const editable = skill.source === "user";

  if (editing) {
    return (
      <SkillEditor
        initialTitle={skill.title}
        initialInstructions={skill.instructions}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={async (title, instructions) => {
          await update(skill.id, title, instructions);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div
      className={`rounded-xl border p-3 transition ${
        skill.enabled ? "border-emerald-400/30 bg-emerald-400/[0.06]" : "border-white/10 bg-black/20"
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-sm text-neutral-200">{skill.title}</span>
        {skill.source === "predefined" && (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
            Starter
          </span>
        )}
        {skill.enabled && (
          <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300/90">
            Active
          </span>
        )}
        <div className="ml-auto shrink-0">
          <Toggle
            checked={skill.enabled}
            label={`Turn ${skill.title} ${skill.enabled ? "off" : "on"}`}
            onChange={(enabled) => void setEnabled(skill.id, enabled)}
          />
        </div>
      </div>

      <p className="whitespace-pre-wrap text-[11px] leading-snug text-neutral-500">{skill.instructions}</p>

      {editable && (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="app-no-drag cursor-pointer rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-white/10"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await remove(skill.id);
              } finally {
                setBusy(false);
              }
            }}
            className="app-no-drag cursor-pointer rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-400 transition hover:bg-white/10 hover:text-amber-300/90 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** The "add a skill of your own" affordance: a button that opens the create form inline. */
function AddSkill() {
  const create = useSkillsStore((state) => state.create);
  const [adding, setAdding] = useState(false);

  if (adding) {
    return (
      <SkillEditor
        initialTitle=""
        initialInstructions=""
        submitLabel="Add skill"
        onCancel={() => setAdding(false)}
        onSubmit={async (title, instructions) => {
          await create(title, instructions);
          setAdding(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="app-no-drag w-full cursor-pointer rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-xs text-neutral-400 transition hover:border-white/25 hover:bg-white/5 hover:text-neutral-200"
    >
      + Add a skill
    </button>
  );
}

/**
 * The shared create/edit form: a title field and an instructions area. Save is disabled
 * until both are non-empty (the store and the Core both require a non-empty body). Used for
 * both creating a new Skill and editing an existing one.
 */
function SkillEditor({
  initialTitle,
  initialInstructions,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialTitle: string;
  initialInstructions: string;
  submitLabel: string;
  onSubmit: (title: string, instructions: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [busy, setBusy] = useState(false);

  const canSubmit = title.trim().length > 0 && instructions.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    try {
      await onSubmit(title.trim(), instructions.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-white/15 bg-black/30 p-3">
      <input
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Skill name, e.g. Explain like I'm five"
        className="app-no-drag w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
      />
      <textarea
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        placeholder="What should Lune do when this skill is on? Write it as instructions, e.g. 'always define technical terms in plain words.'"
        rows={4}
        className="app-no-drag w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs leading-snug text-neutral-100 placeholder:text-neutral-600 focus:border-white/25 focus:outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
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
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

/** A small on/off switch, matching the Settings toggle (emerald when on). */
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
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-4" : "left-0.5"}`}
      />
    </button>
  );
}
