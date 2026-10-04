#!/usr/bin/env node
// Screenshot one page of the preview at laptop 1440x900 and phone 390x844.
// Called by `greatstone-preview.sh shot` (GRE-606):
//   node scripts/preview-shot.mjs <url> <laptop.png> <phone.png>
// Only http://localhost:3200 is allowed: never the live app on 3100.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const [, , url, laptopOut, phoneOut] = process.argv;
if (!url || !laptopOut || !phoneOut) {
  console.error("usage: preview-shot.mjs <url> <laptop.png> <phone.png>");
  process.exit(2);
}
const target = new URL(url);
if (target.protocol !== "http:" || target.host !== "localhost:3200") {
  console.error(`preview-shot: refusing ${target.origin}; only http://localhost:3200 (the preview) is allowed.`);
  process.exit(2);
}

const views = [
  { out: laptopOut, viewport: { width: 1440, height: 900 } },
  { out: phoneOut, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

const browser = await chromium.launch({ headless: true }).catch((error) => {
  console.error(`preview-shot: could not start the browser: ${error.message.split("\n")[0]}`);
  console.error("Install it with: npx playwright install chromium (and, on Linux, npx playwright install-deps).");
  process.exit(1);
});
try {
  for (const { out, ...options } of views) {
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    const ctx = await browser.newContext({ ...options, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(target.href, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out, fullPage: false });
    await ctx.close();
  }
} finally {
  await browser.close();
}
