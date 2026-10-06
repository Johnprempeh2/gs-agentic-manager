// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { buildEmailPreviewDocument } from "./EmailHtmlPreview";
import { MarkdownBody } from "./MarkdownBody";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({ issuesApi: { get: vi.fn() } }));

vi.mock("../context/CompanyContext", () => ({
  useOptionalCompany: () => ({ selectedCompanyId: "company-1", companies: [] }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(markdown: string, renderEmailHtml: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MarkdownBody renderEmailHtml={renderEmailHtml}>{markdown}</MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

const html = `<p>Hello <b>Sam</b>, see <a href="https://example.com/plan" target="_self">the plan</a>.</p>`;
const previewMarkdown = ["Send email", "", "- **Message (HTML):**", "", "```email-html", html, "```"].join("\n");

describe("HTML email body on the send approval card (GRE-965)", () => {
  it("draws the HTML in a fully sandboxed frame, not as markup text", () => {
    const node = render(previewMarkdown, true);
    const frame = node.querySelector("iframe");
    expect(frame).not.toBeNull();
    // An empty sandbox turns on every restriction: no scripts, forms, pop-ups or same-origin.
    expect(frame!.getAttribute("sandbox")).toBe("");
    const srcDoc = frame!.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("<b>Sam</b>");
    expect(srcDoc).toContain("default-src 'none'");
    expect(node.querySelector("pre")).toBeNull();
  });

  it("shows the source on request and goes back to the email", () => {
    const node = render(previewMarkdown, true);
    const toggle = Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Show source");
    expect(toggle).toBeDefined();
    act(() => toggle!.click());
    expect(node.querySelector("iframe")).toBeNull();
    expect(node.querySelector("pre code")?.textContent).toBe(html);
    const back = Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Show email");
    act(() => back!.click());
    expect(node.querySelector("iframe")).not.toBeNull();
  });

  it("leaves the block as plain code where the card did not ask for it", () => {
    const node = render(previewMarkdown, false);
    expect(node.querySelector("iframe")).toBeNull();
    expect(node.querySelector("pre code")?.textContent).toContain(html);
  });

  it("keeps quoted plain-text bodies unchanged", () => {
    const node = render("Send email\n\n- **Message:**\n\n> Hi \\<b\\>Sam\\</b\\>", true);
    expect(node.querySelector("iframe")).toBeNull();
    expect(node.querySelector("blockquote")?.textContent).toContain("Hi <b>Sam</b>");
  });
});

describe("buildEmailPreviewDocument", () => {
  it("removes scripts, base and refresh tags, and switches links off but keeps their address", () => {
    const doc = buildEmailPreviewDocument(
      `<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">` +
        `<script>alert(1)</script><p><a href="https://evil.example/pay" target="_top">Pay</a></p>` +
        `<map><area href="https://evil.example/area"></map>`,
    );
    expect(doc).not.toContain("<script");
    expect(doc).not.toContain("<base");
    expect(doc).not.toContain("refresh");
    expect(doc).not.toContain('href="https://evil.example');
    expect(doc).not.toContain("_top");
    expect(doc).toContain('title="https://evil.example/pay"');
    expect(doc).toContain(">Pay</a>");
  });

  it("blocks every remote load with a content security policy at the top of the document", () => {
    const doc = buildEmailPreviewDocument(`<img src="https://tracker.example/pixel.gif"><p>Hi</p>`);
    const policyIndex = doc.indexOf('http-equiv="Content-Security-Policy"');
    expect(policyIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeLessThan(doc.indexOf("<img"));
    expect(doc).toContain("img-src data:");
    expect(doc).not.toMatch(/img-src[^;]*https/);
  });
});
