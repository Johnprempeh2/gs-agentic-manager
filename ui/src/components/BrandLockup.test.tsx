// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PartnerBranding } from "@greatstone/shared";
import { buildDocumentTitle } from "../context/BreadcrumbContext";
import { getPartnerBranding, getProductName, resetPartnerBrandingCache } from "../lib/partner-branding";
import { BrandLockup, PoweredByGreatstone } from "./BrandLockup";
import { SidebarBrandSignature } from "./SidebarBrandSignature";

function setPartnerBranding(branding: PartnerBranding | string) {
  const meta = document.createElement("meta");
  meta.name = "gsam-partner-branding";
  meta.content = typeof branding === "string" ? branding : JSON.stringify(branding);
  document.head.appendChild(meta);
  resetPartnerBrandingCache();
}

const partner: PartnerBranding = {
  name: "Partner Co",
  logoUrl: "https://cdn.example.com/partner-logo.svg",
  colors: { light: null, dark: null },
};

afterEach(() => {
  document.head.innerHTML = "";
  resetPartnerBrandingCache();
});

describe("partner branding in the UI (GRE-1192)", () => {
  describe("unbranded instance", () => {
    it("keeps our product name, stone and title, with no Powered-by line", () => {
      expect(getPartnerBranding()).toBeNull();
      expect(getProductName()).toBe("GS Agentic Manager");

      const lockup = renderToStaticMarkup(<BrandLockup />);
      expect(lockup).toContain('aria-label="GS Agentic Manager"');
      expect(lockup).toContain("<svg");
      expect(lockup).not.toContain("<img");

      expect(renderToStaticMarkup(<PoweredByGreatstone />)).toBe("");

      const sidebar = renderToStaticMarkup(<SidebarBrandSignature />);
      expect(sidebar).toContain('class="mt-auto flex shrink-0 px-2 pt-6 pb-1 items-center"');
      expect(sidebar).not.toContain("Powered by");

      expect(buildDocumentTitle([{ label: "Inbox" }], "Acme")).toBe("Inbox • Acme • GS Agentic Manager");
    });

    it("falls back to our brand when the head carries unreadable branding", () => {
      setPartnerBranding("{not json");
      expect(getPartnerBranding()).toBeNull();
      expect(getProductName()).toBe("GS Agentic Manager");
    });
  });

  describe("partner-branded instance", () => {
    it("shows the partner logo and name with the fixed Powered-by line", () => {
      setPartnerBranding(partner);

      const lockup = renderToStaticMarkup(<BrandLockup />);
      expect(lockup).toContain('aria-label="Partner Co"');
      expect(lockup).toContain('src="https://cdn.example.com/partner-logo.svg"');
      expect(lockup).not.toContain("<svg");
      expect(lockup).not.toContain("GS Agentic Manager");

      const sidebar = renderToStaticMarkup(<SidebarBrandSignature />);
      expect(sidebar).toContain("Partner Co");
      expect(sidebar).toContain("Powered by Greatstone");

      expect(buildDocumentTitle([{ label: "Inbox" }], "Acme")).toBe("Inbox • Acme • Partner Co");
    });

    it("never puts our stone beside a partner name that has no logo", () => {
      setPartnerBranding({ ...partner, logoUrl: null });

      const lockup = renderToStaticMarkup(<BrandLockup />);
      expect(lockup).toContain("Partner Co");
      expect(lockup).not.toContain("<svg");
      expect(lockup).not.toContain("<img");
      expect(renderToStaticMarkup(<PoweredByGreatstone />)).toContain("Powered by Greatstone");
    });

    it("shows the Powered-by line even when only the colour is set", () => {
      setPartnerBranding({
        name: null,
        logoUrl: null,
        colors: { light: { primary: "#0f766e", primaryForeground: "#f5f7f2" }, dark: null },
      });

      expect(getProductName()).toBe("GS Agentic Manager");
      expect(renderToStaticMarkup(<PoweredByGreatstone />)).toContain("Powered by Greatstone");
    });
  });
});
