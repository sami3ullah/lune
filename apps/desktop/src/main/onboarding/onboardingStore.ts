// The onboarding-complete flag (ticket 14 acceptance: "Onboarding-complete state
// persisted; returning users never see onboarding again"). It is a tiny JSON document
// under the app's userData, behind an injected filesystem seam like the Pill position
// and conversation stores, so it is testable without a real disk. The absence of the
// file (or a corrupt one) reads as "not complete", so a fresh machine always sees
// onboarding and a torn write never traps a returning user in it.

/** Reads the onboarding flag file, or throws if it is absent. */
export type ReadOnboardingFile = (filePath: string) => string;
/** Writes the onboarding flag file (best-effort). */
export type WriteOnboardingFile = (filePath: string, contents: string) => void;

/** Persists whether the user has finished onboarding. */
export class OnboardingStore {
  constructor(
    private readonly filePath: string,
    private readonly readFile: ReadOnboardingFile,
    private readonly writeFile: WriteOnboardingFile,
  ) {}

  /**
   * Whether onboarding has been completed. A missing or malformed flag file reads as
   * `false`, so a fresh profile always runs onboarding and a corrupt file never
   * silently skips it.
   */
  isComplete(): boolean {
    let raw: string;
    try {
      raw = this.readFile(this.filePath);
    } catch {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as { completed?: unknown }).completed === true
      );
    } catch {
      return false;
    }
  }

  /**
   * Marks onboarding complete and persists it. A write failure is swallowed (re-running
   * onboarding once more is never worth crashing the app) but logged.
   */
  markComplete(): void {
    try {
      this.writeFile(this.filePath, JSON.stringify({ completed: true }));
    } catch (error) {
      console.error("[lune] could not persist onboarding completion:", error);
    }
  }
}
