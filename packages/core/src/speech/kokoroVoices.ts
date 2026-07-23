/**
 * Kokoro's 54 built-in Voices and their validation, carried from v1
 * (`kokoroSpeechEngine.ts`). The user picks among these in Settings (the picker UI
 * arrives in ticket 13); the Shell mirrors this list for that picker. Kept in one
 * place so voice validation and the default are unambiguous, and in lockstep with the
 * Provisioning manifest's per-voice files (`manifest.ts`).
 */

/**
 * Kokoro's 54 built-in Voices (hexgrad/Kokoro-82M v1.0), grouped by language.
 */
export const KOKORO_VOICES: readonly string[] = [
  // American English
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
  "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
  "am_onyx", "am_puck", "am_santa",
  // British English
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  // Japanese
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  // Mandarin Chinese
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
  "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
  // Spanish
  "ef_dora", "em_alex", "em_santa",
  // French
  "ff_siwis",
  // Hindi
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  // Italian
  "if_sara", "im_nicola",
  // Brazilian Portuguese
  "pf_dora", "pm_alex", "pm_santa",
];

/** The default Voice when none is selected: Kokoro's flagship "af_heart". */
export const DEFAULT_KOKORO_VOICE = "af_heart";

/** Whether a Voice name is one of Kokoro's built-in Voices. */
export function isKnownKokoroVoice(voice: string): boolean {
  return KOKORO_VOICES.includes(voice);
}
