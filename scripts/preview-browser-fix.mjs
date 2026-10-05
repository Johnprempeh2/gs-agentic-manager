// Names the one step that fixes a preview-shot browser that will not start
// (GRE-732). Anyone can install the browser itself; its system libraries need
// sudo, so only John can install those.
export function browserFix(message, browsersPath) {
  if (/error while loading shared libraries|missing dependencies|Host system is missing/i.test(message)) {
    const libs = [...new Set(message.match(/\blib[\w+-]+(?:\.[\w+-]+)*\.so(?:\.\d+)*/g) ?? [])];
    return `The host is missing system libraries${libs.length ? ` (${libs.join(", ")})` : ""}. ` +
      "John must install them once with: sudo npx playwright install-deps chromium " +
      "(see 'Screenshots' in doc/GREATSTONE-WAY-OF-WORKING.md).";
  }
  if (/Executable doesn't exist/i.test(message)) {
    const where = browsersPath ? `PLAYWRIGHT_BROWSERS_PATH=${browsersPath} ` : "";
    return `The browser is not installed. Install it once with: ${where}npx playwright install chromium-headless-shell`;
  }
  return `See 'Screenshots' in doc/GREATSTONE-WAY-OF-WORKING.md. Browser folder: ${browsersPath || "Playwright's default"}.`;
}
