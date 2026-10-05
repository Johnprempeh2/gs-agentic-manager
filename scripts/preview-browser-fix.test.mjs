// Tests for the fix step preview-shot.mjs prints when the browser will not start (GRE-732).
import assert from "node:assert/strict";
import test from "node:test";
import { browserFix } from "./preview-browser-fix.mjs";

test("a browser that is not installed names the install command and the folder", () => {
  const message = "browserType.launch: Executable doesn't exist at /pw/chromium_headless_shell-1234/chrome-headless-shell\n"
    + "║     npx playwright install                                 ║";
  assert.equal(browserFix(message, "/home/u/.cache/ms-playwright"),
    "The browser is not installed. Install it once with: PLAYWRIGHT_BROWSERS_PATH=/home/u/.cache/ms-playwright npx playwright install chromium-headless-shell");
});

test("missing system libraries name the libraries and say John must install them", () => {
  // As Playwright 1.62 reports it on Ubuntu 24.04 without libnspr4.
  const message = "browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n"
    + "[pid=1][err] /pw/chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file\n"
    + "  - [pid=1][err] /pw/chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file\n";
  const fix = browserFix(message, "/pw");
  assert.match(fix, /^The host is missing system libraries \(libnspr4\.so\)\. John must install them once with: sudo npx playwright install-deps chromium/);
  assert.doesNotMatch(fix, /playwright install chromium-headless-shell/);
  assert.match(browserFix("Host system is missing dependencies to run browsers. libnss3.so libasound.so.2", ""),
    /\(libnss3\.so, libasound\.so\.2\)/);
});

test("any other launch error points to the doc and the browser folder", () => {
  assert.match(browserFix("browserType.launch: Timeout 180000ms exceeded.", "/pw"), /'Screenshots' in doc\/GREATSTONE-WAY-OF-WORKING\.md\. Browser folder: \/pw\./);
});
