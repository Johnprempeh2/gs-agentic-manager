// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleImage, BrandLogo, monogram } from "./IntelligenceMedia";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-1" }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode) => act(() => root.render(node));

describe("BrandLogo", () => {
  it("asks our own server for the logo, never a remote host", () => {
    render(<BrandLogo name="Anthropic" url="https://www.anthropic.com/claude" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/companies/co-1/intelligence/logo/anthropic.com");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("falls back to a monogram when the logo fails (no key, no match), never a broken image", () => {
    render(<BrandLogo name="Google DeepMind" domain="deepmind.google" />);
    expect(container.querySelector("img")).not.toBeNull();
    act(() => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("GD");
  });

  it("shows the monogram straight away with no domain to look up", () => {
    render(<BrandLogo name="Cline" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("CL");
  });

  it("makes initials from the name", () => {
    expect(monogram("OpenAI")).toBe("OP");
    expect(monogram("Meta AI")).toBe("MA");
    expect(monogram("  ")).toBe("?");
  });
});

describe("ArticleImage", () => {
  it("loads the article's preview through our server in a fixed-ratio box, and shows the fallback when there is none", () => {
    render(<ArticleImage url="https://techcrunch.com/a?b=1" fallback={<span>logo</span>} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`/api/companies/co-1/intelligence/image?url=${encodeURIComponent("https://techcrunch.com/a?b=1")}`);
    expect(container.firstElementChild!.className).toContain("aspect-video");
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("logo");
    expect(container.firstElementChild!.className).toContain("aspect-video");
  });

  it("prefers the agent's imageUrl over the page's own", () => {
    render(<ArticleImage url="https://techcrunch.com/a" imageUrl="https://cdn.example.com/x.png" />);
    expect(container.querySelector("img")!.getAttribute("src")).toContain(encodeURIComponent("https://cdn.example.com/x.png"));
  });
});
