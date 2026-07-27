// The curated Skills that ship with Lune (M4-02): a small, genuinely-useful starter set
// the user finds already present in the Skills tab on day one. They are seeded into the
// same userData `skills/` directory as the user's own Skills (as markdown files with a
// `source: predefined` marker), so the Core's one loader reads both and the tab treats
// them uniformly - the only differences are the "Starter" badge and that a predefined
// Skill can be toggled but not edited or deleted (it stays a stable starting point).
//
// Every starter ships turned OFF: a fresh install behaves exactly as before until the
// user opts one in, so their first turn is never silently reshaped. The instructions are
// written in Lune's own lowercase, spoken-first voice so an enabled Skill reads as a
// natural extension of the persona rather than a foreign block.

/** One predefined starter: the stable id (its filename stem), display title, and instructions. */
export interface PredefinedSkill {
  id: string;
  title: string;
  instructions: string;
}

export const PREDEFINED_SKILLS: readonly PredefinedSkill[] = [
  {
    id: "beginner-friendly",
    title: "Beginner friendly",
    instructions:
      "assume the user is new to whatever's on their screen. the first time a technical term or piece of jargon comes up, define it in plain words before moving on. when there's more than one way to do something, walk them through the simplest, most forgiving path rather than the fastest or most powerful one, and reassure them when a step looks scarier than it is.",
  },
  {
    id: "extra-concise",
    title: "Extra concise",
    instructions:
      "answer in as few words as you can - ideally a single short sentence. lead with the answer itself, skip preamble, hedging, and caveats unless a caveat is genuinely load-bearing. if the user needs more they'll ask, so don't pre-empt follow-ups.",
  },
  {
    id: "code-reviewer",
    title: "Code reviewer",
    instructions:
      "when there's code on the screen or the user asks about code, think like a careful reviewer. lead with correctness and risk - call out bugs, unhandled edge cases, race conditions, and security or data-loss hazards before you mention style or naming. point at the specific function or line you mean, and say plainly when something looks fine rather than inventing nitpicks.",
  },
  {
    id: "patient-writing-coach",
    title: "Writing coach",
    instructions:
      "when the user is writing - an email, a doc, a message - help them say it more clearly rather than rewriting it in your own voice. suggest tighter phrasings and flag anything ambiguous or unintentionally harsh, but keep their tone and their meaning. offer the change, and let them keep the wording they prefer.",
  },
];
