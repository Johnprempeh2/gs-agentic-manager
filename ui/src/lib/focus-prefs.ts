/** Browser-saved choices for the Decisions page view and Focus mode (GRE-55). */

export type DecisionsView = "list" | "focus";

export const DECISIONS_VIEW_KEY = "paperclip:attention:view";
export const FOCUS_PREFS_KEY = "paperclip:attention:focus-prefs";

export const FOCUS_SPEEDS = [1, 1.25, 1.5, 2] as const;
export type FocusSpeed = (typeof FOCUS_SPEEDS)[number];

export interface FocusPrefs {
  /** "Read each question aloud" — off by default. */
  autoRead: boolean;
  rate: FocusSpeed;
  /** SpeechSynthesisVoice.voiceURI; null = the browser's default voice. */
  voiceURI: string | null;
}

export const defaultFocusPrefs: FocusPrefs = { autoRead: false, rate: 1, voiceURI: null };

export function loadDecisionsView(): DecisionsView {
  try {
    return localStorage.getItem(DECISIONS_VIEW_KEY) === "focus" ? "focus" : "list";
  } catch {
    return "list";
  }
}

export function saveDecisionsView(view: DecisionsView) {
  try {
    localStorage.setItem(DECISIONS_VIEW_KEY, view);
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadFocusPrefs(): FocusPrefs {
  try {
    const raw = localStorage.getItem(FOCUS_PREFS_KEY);
    if (!raw) return defaultFocusPrefs;
    const parsed = JSON.parse(raw) as Partial<FocusPrefs>;
    return {
      autoRead: parsed.autoRead === true,
      rate: FOCUS_SPEEDS.find((speed) => speed === parsed.rate) ?? 1,
      voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : null,
    };
  } catch {
    return defaultFocusPrefs;
  }
}

export function saveFocusPrefs(prefs: FocusPrefs) {
  try {
    localStorage.setItem(FOCUS_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore localStorage failures.
  }
}

export function nextFocusSpeed(rate: FocusSpeed): FocusSpeed {
  const index = FOCUS_SPEEDS.indexOf(rate);
  return FOCUS_SPEEDS[(index + 1) % FOCUS_SPEEDS.length]!;
}
