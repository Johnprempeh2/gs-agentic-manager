// Names the one step that fixes a preview-shot browser that will not start
// (GRE-732). Anyone can install the browser itself. Missing system libraries
// are fetched without root by chromium-libs.mjs (GRE-1065); only when that
// fetch fails (fetchError) must John install them with sudo.
export function browserFix(message, browsersPath, fetchError) {
  if (/error while loading shared libraries|missing dependencies|Host system is missing/i.test(message)) {
    const libs = [...new Set(message.match(/\blib[\w+-]+(?:\.[\w+-]+)*\.so(?:\.\d+)*/g) ?? [])];
    const missing = `The host is missing system libraries${libs.length ? ` (${libs.join(", ")})` : ""}. `;
    if (fetchError) {
      return `${missing}The no-root fetch failed: ${fetchError}. ` +
        "John must install them once with: sudo npx playwright install-deps chromium " +
        "(see 'Screenshots' in doc/GREATSTONE-WAY-OF-WORKING.md).";
    }
    return `${missing}Fetch them without root with: node scripts/chromium-libs.mjs ` +
      "(it prints why if it cannot; see 'Screenshots' in doc/GREATSTONE-WAY-OF-WORKING.md).";
  }
  if (/Executable doesn't exist/i.test(message)) {
    const where = browsersPath ? `PLAYWRIGHT_BROWSERS_PATH=${browsersPath} ` : "";
    return `The browser is not installed. Install it once with: ${where}npx playwright install chromium-headless-shell`;
  }
  return `See 'Screenshots' in doc/GREATSTONE-WAY-OF-WORKING.md. Browser folder: ${browsersPath || "Playwright's default"}.`;
}
