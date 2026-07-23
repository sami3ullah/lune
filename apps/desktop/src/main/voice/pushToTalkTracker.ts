import type { HotkeyModifier, ParsedHotkey } from "../../ipc/hotkey";

// The pure push-to-talk transition tracker (ticket 11): given a stream of global key
// events and the configured hotkey chord, it decides the exact moments the chord
// becomes fully held ("pressed") and stops being fully held ("released"). This is the
// hold-to-talk heart of the voice loop - hold ctrl+option to talk, release to send -
// and it is one of the M1 Shell's named pure-logic seams, so it lives here, tested,
// separate from the platform key source that feeds it (`globalKeyEventSource`).
//
// It is the successor of v1's `BuddyPushToTalkShortcut.shortcutTransition`: modifier
// state is taken from each event's live modifier flags (authoritative every event, so a
// missed modifier keydown/up can never desync the chord), while a chord's optional main
// key is tracked by its own down/up. A chord is held when every configured modifier is
// down and (for a chord with a main key) that key is down too - extra keys held
// alongside do not break the match, matching v1's "contains"/superset semantics.

/** The four modifier flags, as each global key event reports them (post-event state). */
export interface HotkeyModifierState {
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * One normalized global key event the tracker consumes. The platform source
 * (`globalKeyEventSource`) maps each raw OS event to this shape: whether a key went
 * down or up, the live modifier flags after that change, and the canonical token of the
 * non-modifier key involved (e.g. "Space", "A"), or `null` when the event is a modifier
 * key or an unmapped key.
 */
export interface PushToTalkKeyEvent {
  kind: "down" | "up";
  modifiers: HotkeyModifierState;
  /** The non-modifier key this event concerns, canonicalized, or `null`. */
  mainKey: string | null;
}

/** Whether this event completed, broke, or did not change the held-chord state. */
export type PushToTalkTransition = "pressed" | "released" | "none";

/**
 * Tracks whether the configured hotkey chord is currently held, emitting a transition
 * only at the edges (the frame it becomes held, and the frame it stops). The binding is
 * read live via {@link getBinding} on every event, so editing the hotkey in Settings
 * takes effect immediately with no rebuild (the config store reloads on the file change).
 */
export class PushToTalkTracker {
  /** The main (non-modifier) key currently held, or `null` - modifiers come per-event. */
  private heldMainKey: string | null = null;
  /** Whether the chord was fully held after the previous event, to detect the edges. */
  private wasChordHeld = false;

  constructor(private readonly getBinding: () => ParsedHotkey) {}

  /**
   * Folds one key event into the held state and returns the resulting transition.
   * "pressed" the moment the whole chord becomes held; "released" the moment it stops;
   * "none" otherwise (including repeats while held).
   */
  handle(event: PushToTalkKeyEvent): PushToTalkTransition {
    // Track the single held main key from its own down/up. A down adopts it; an up
    // clears it only if it is the one we were holding (a different key's up is noise).
    if (event.mainKey !== null) {
      if (event.kind === "down") {
        this.heldMainKey = event.mainKey;
      } else if (this.heldMainKey === event.mainKey) {
        this.heldMainKey = null;
      }
    }

    const isChordHeld = this.isChordSatisfied(event.modifiers);
    const transition: PushToTalkTransition = isChordHeld
      ? this.wasChordHeld
        ? "none"
        : "pressed"
      : this.wasChordHeld
        ? "released"
        : "none";
    this.wasChordHeld = isChordHeld;
    return transition;
  }

  /**
   * Clears all held state (and the held-edge memory) so the next event starts fresh.
   * The platform source calls this when the OS hook restarts or is disabled/re-enabled,
   * so a key-up missed during the gap can never leave the chord wedged "held".
   */
  reset(): void {
    this.heldMainKey = null;
    this.wasChordHeld = false;
  }

  /** Whether the current physical state satisfies the configured chord right now. */
  private isChordSatisfied(modifiers: HotkeyModifierState): boolean {
    const binding = this.getBinding();
    const everyModifierHeld = binding.modifiers.every(
      (modifier: HotkeyModifier) => modifiers[modifier],
    );
    if (!everyModifierHeld) {
      return false;
    }
    return binding.key === null || this.heldMainKey === binding.key;
  }
}
