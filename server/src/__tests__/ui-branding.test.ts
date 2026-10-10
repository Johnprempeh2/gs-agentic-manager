import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  renderPartnerBrandingHead,
  renderPartnerWebManifest,
  getWorktreeUiBranding,
  isWorktreeUiBrandingEnabled,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
} from "../ui-branding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATE = `<!doctype html>
<head>
    <!-- GSAM_RUNTIME_BRANDING_START -->
    <!-- GSAM_RUNTIME_BRANDING_END -->
    <!-- GSAM_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <!-- GSAM_FAVICON_END -->
</head>`;

describe("ui branding", () => {
  it("detects worktree mode from GSAM_IN_WORKTREE", () => {
    expect(isWorktreeUiBrandingEnabled({ GSAM_IN_WORKTREE: "true" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ GSAM_IN_WORKTREE: "1" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ GSAM_IN_WORKTREE: "false" })).toBe(false);
  });

  it("resolves name, color, and text color for worktree branding", () => {
    const branding = getWorktreeUiBranding({
      GSAM_IN_WORKTREE: "true",
      GSAM_WORKTREE_NAME: "paperclip-pr-432",
      GSAM_WORKTREE_COLOR: "#4f86f7",
    });

    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("paperclip-pr-432");
    expect(branding.color).toBe("#4f86f7");
    expect(branding.textColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(branding.faviconHref).toContain("data:image/svg+xml,");
  });

  it("renders a dynamic worktree favicon when enabled", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        GSAM_IN_WORKTREE: "true",
        GSAM_WORKTREE_NAME: "paperclip-pr-432",
        GSAM_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).toContain("data:image/svg+xml,");
    expect(links).toContain('rel="shortcut icon"');
  });

  it("renders runtime branding metadata for the ui", () => {
    const meta = renderRuntimeBrandingMeta(
      getWorktreeUiBranding({
        GSAM_IN_WORKTREE: "true",
        GSAM_WORKTREE_NAME: "paperclip-pr-432",
        GSAM_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(meta).toContain('name="paperclip-worktree-name"');
    expect(meta).toContain('content="paperclip-pr-432"');
    expect(meta).toContain('name="paperclip-worktree-color"');
  });

  it("surfaces the runtime instance id so the UI can fail closed on copied rows", () => {
    const branding = getWorktreeUiBranding({
      GSAM_IN_WORKTREE: "true",
      GSAM_WORKTREE_NAME: "paperclip-pr-432",
      GSAM_WORKTREE_COLOR: "#4f86f7",
      GSAM_INSTANCE_ID: "inst-abc123",
    });
    expect(branding.instanceId).toBe("inst-abc123");

    const meta = renderRuntimeBrandingMeta(branding);
    expect(meta).toContain('name="paperclip-instance-id"');
    expect(meta).toContain('content="inst-abc123"');
  });

  it("omits the instance-id meta when the runtime id is unset", () => {
    const branding = getWorktreeUiBranding({
      GSAM_IN_WORKTREE: "true",
      GSAM_WORKTREE_NAME: "paperclip-pr-432",
      GSAM_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branding.instanceId).toBeNull();
    expect(renderRuntimeBrandingMeta(branding)).not.toContain('name="paperclip-instance-id"');
  });

  it("rewrites the favicon and runtime branding blocks for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, {
      GSAM_IN_WORKTREE: "true",
      GSAM_WORKTREE_NAME: "paperclip-pr-432",
      GSAM_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).toContain('name="paperclip-worktree-name"');
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain('name="paperclip-worktree-name"');
  });
});

describe("partner branding in the HTML shell (GRE-1192)", () => {
  const SHELL = `<head>
    <meta name="apple-mobile-web-app-title" content="GS Agentic Manager" />
    <title>GS Agentic Manager</title>
    <!-- GSAM_RUNTIME_BRANDING_START -->
    <!-- GSAM_RUNTIME_BRANDING_END -->
    <!-- GSAM_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <!-- GSAM_FAVICON_END -->
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
</head>
<body>
  <h1 id="paperclip-startup-title" class="text-lg font-semibold">GS Agentic Manager couldn’t start</h1>
  <script>
    title.textContent = "GS Agentic Manager couldn’t start";
    title.textContent = "GS Agentic Manager is taking longer to load";
  </script>
</body>`;

  it("leaves the real index.html byte-identical when no brand env var is set", () => {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, "../../../ui/index.html"), "utf-8");
    expect(applyUiBranding(indexHtml, {})).toBe(indexHtml);
  });

  it("swaps the product name, favicon, touch icon and theme colours", () => {
    const html = applyUiBranding(SHELL, {
      GSAM_BRAND_NAME: "Partner Co",
      GSAM_BRAND_LOGO_URL: "https://cdn.example.com/partner-logo.svg",
      GSAM_BRAND_PRIMARY_COLOR: "#0f766e",
    });

    expect(html).not.toContain("GS Agentic Manager");
    expect(html).toContain("<title>Partner Co</title>");
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Partner Co" />');
    expect(html).toContain(">Partner Co couldn’t start</h1>");
    expect(html).toContain('title.textContent = "Partner Co is taking longer to load";');
    expect(html).toContain('<link rel="icon" href="https://cdn.example.com/partner-logo.svg" />');
    expect(html).not.toContain("/favicon.ico");
    expect(html).toContain('<link rel="apple-touch-icon" href="https://cdn.example.com/partner-logo.svg" />');
    expect(html).toContain("html:root:not(.dark){--primary:#0f766e;");
    expect(html).toContain("html.dark{--primary:#0f766e;");
    expect(html).toContain('<meta name="gsam-partner-branding" content="{&quot;name&quot;:&quot;Partner Co&quot;,');
  });

  it("escapes a partner name for HTML and for the inline script", () => {
    const html = applyUiBranding(SHELL, { GSAM_BRAND_NAME: `Partner "&" <Co>` });

    expect(html).toContain("<title>Partner \"&amp;\" &lt;Co&gt;</title>");
    expect(html).toContain('content="Partner &quot;&amp;&quot; &lt;Co&gt;"');
    expect(html).toContain('title.textContent = "Partner \\"&\\" \\u003cCo>');
    expect(html).not.toContain("<Co>");
  });

  it("only overrides the theme for a mode whose contrast check passed", () => {
    expect(renderPartnerBrandingHead(null)).toBe("");
    const style = applyUiBranding(SHELL, { GSAM_BRAND_PRIMARY_COLOR: "#1e3a8a" });
    expect(style).toContain("html:root:not(.dark){--primary:#1e3a8a;");
    expect(style).not.toContain("html.dark{");
  });

  it("keeps the worktree favicon over the partner logo", () => {
    const html = applyUiBranding(SHELL, {
      GSAM_IN_WORKTREE: "true",
      GSAM_WORKTREE_NAME: "preview",
      GSAM_BRAND_LOGO_URL: "https://cdn.example.com/partner-logo.svg",
    });
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,');
  });
});

describe("renderPartnerWebManifest", () => {
  it("serves nothing (static manifest) without a partner name or logo", () => {
    expect(renderPartnerWebManifest(null)).toBeNull();
    expect(
      renderPartnerWebManifest({ name: null, logoUrl: null, colors: { light: null, dark: null } }),
    ).toBeNull();
  });

  it("names the phone app after the partner and uses its logo", () => {
    const manifest = JSON.parse(
      renderPartnerWebManifest({
        name: "Partner Co",
        logoUrl: "/partner/logo.png",
        colors: { light: null, dark: null },
      })!,
    );
    expect(manifest.name).toBe("Partner Co");
    expect(manifest.short_name).toBe("Partner Co");
    expect(manifest.icons).toEqual([{ src: "/partner/logo.png", sizes: "any" }]);
    expect(JSON.stringify(manifest)).not.toMatch(/Greatstone|GS Agentic Manager/);
  });
});
