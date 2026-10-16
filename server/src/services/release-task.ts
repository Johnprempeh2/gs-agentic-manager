/**
 * Release tasks stay out of Decisions and "needs me": John runs releases from
 * Claude now, so a stopped preview check or a "release rc-... to live" task is
 * handled there, not on the board. A release task names a release tag
 * (`rc-YYYY-MM-DD.N` or `live-YYYY-MM-DD.N`) and the word "release", like
 * "Release candidate rc-2026-10-15.3: check in preview (GRE-1565)" or
 * "John: release rc-2026-10-15.3 to live (by hand)".
 */
const RELEASE_TAG = /\b(?:rc|live)-\d{4}-\d{2}-\d{2}\.\d+\b/i;
const RELEASE_WORD = /\brelease\b/i;

export function isReleaseTask(title: string | null | undefined) {
  return Boolean(title) && RELEASE_TAG.test(title!) && RELEASE_WORD.test(title!);
}
