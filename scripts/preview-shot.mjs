#!/usr/bin/env node
// Screenshot one page of the preview at laptop 1440x900 and phone 390x844.
// Called by `greatstone-preview.sh shot` (GRE-606):
//   node scripts/preview-shot.mjs <url> <laptop.png> <phone.png> <console.txt>
// Also writes the page's console errors, uncaught page errors and failed
// (status >= 400) localhost:3200 responses to <console.txt> and prints
// "console errors: N", so a page that looks fine but throws is seen (GRE-691).
// Only http://localhost:3200 is allowed: never the live app on 3100.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { browserFix } from "./preview-browser-fix.mjs";
import { ensureChromiumLibs, headlessShell } from "./chromium-libs.mjs";

const [, , url, laptopOut, phoneOut, consoleOut] = process.argv;
if (!url || !laptopOut || !phoneOut || !consoleOut) {
  console.error("usage: preview-shot.mjs <url> <laptop.png> <phone.png> <console.txt>");
  process.exit(2);
}
const target = new URL(url);
if (target.protocol !== "http:" || target.host !== "localhost:3200") {
  console.error(`preview-shot: refusing ${target.origin}; only http://localhost:3200 (the preview) is allowed.`);
  process.exit(2);
}

const views = [
  { name: "laptop", out: laptopOut, viewport: { width: 1440, height: 900 } },
  { name: "phone", out: phoneOut, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

// Load Chromium's system libraries from the shared no-root fetch, so a host
// without them needs no sudo (GRE-1065).
let libEnv = {};
let fetchError;
const binary = process.platform === "linux"
  ? headlessShell(process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright"))
  : undefined;
if (binary) {
  try {
    libEnv = ensureChromiumLibs(binary);
  } catch (error) {
    fetchError = error.message;
  }
}
const browser = await chromium.launch({ headless: true, env: { ...process.env, ...libEnv } }).catch((error) => {
  console.error(`preview-shot: could not start the browser: ${error.message.split("\n")[0]}`);
  console.error(browserFix(error.message, process.env.PLAYWRIGHT_BROWSERS_PATH, fetchError));
  process.exit(1);
});
const errors = [];
try {
  for (const { name, out, ...options } of views) {
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    const ctx = await browser.newContext({ ...options, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`[${name}] console: ${msg.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`[${name}] pageerror: ${error.message}`));
    page.on("response", (res) => {
      const resUrl = new URL(res.url());
      if (res.status() >= 400 && resUrl.host === target.host) {
        errors.push(`[${name}] http ${res.status()}: ${res.request().method()} ${resUrl.pathname}${resUrl.search}`);
      }
    });
    await page.goto(target.href, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out, fullPage: false });
    await ctx.close();
  }
} finally {
  await browser.close();
}
await fs.mkdir(path.dirname(path.resolve(consoleOut)), { recursive: true });
await fs.writeFile(consoleOut, `${target.href}\nconsole errors: ${errors.length}\n${errors.map((e) => `${e}\n`).join("")}`);
console.log(`console errors: ${errors.length}`);
