import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { injectDeliverableReviewScript } from "../services/deliverable-review-script.js";

// GRE-1223: the review frame script picks elements and areas, and finds them
// again to draw markers. jsdom has no layout, so boxes are checked by their
// presence and ids, not their pixels.

type ReviewApi = {
  pathOf: (el: Element) => string;
  describe: (el: Element) => string;
  pickable: (el: Element) => Element | null;
  findElement: (locator: { path: string; tag: string; label: string | null }) => Element | null;
  regionLocator: (rect: { left: number; top: number; right: number; bottom: number }) => {
    path: string;
    tag: string;
    label: string;
    box: { x: number; y: number; width: number; height: number };
  };
};

const PAGE = `<html><body>
  <h1>Q3 board pack</h1>
  <figure><img src="/files/q3-chart.png?v=2" alt="Q3 revenue chart"><figcaption>Revenue by month</figcaption></figure>
  <p>Revenue grew in <a href="https://example.com">Accra</a>.</p>
  <svg viewBox="0 0 10 10"><title>Costs by region</title><g><rect width="5" height="5"></rect></g></svg>
  <table><caption>Headcount</caption><tbody><tr><td><span>Accra</span></td><td>12</td></tr></tbody></table>
  <section><div>Slide two</div></section>
</body></html>`;

function load(html = PAGE) {
  const dom = new JSDOM(injectDeliverableReviewScript(html), { runScripts: "dangerously" });
  const window = dom.window as unknown as Window & { __gsamReview: ReviewApi };
  const sent: Array<Record<string, unknown>> = [];
  window.parent.postMessage = ((message: Record<string, unknown>) => { sent.push(message); }) as Window["postMessage"];
  const toFrame = (data: Record<string, unknown>) =>
    window.dispatchEvent(new window.MessageEvent("message", { data: { gsamReview: 1, ...data }, source: window }));
  return { window, document: window.document, api: window.__gsamReview, sent, toFrame };
}

function click(window: Window, target: Element, init: MouseEventInit = {}) {
  const options = { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...init };
  target.dispatchEvent(new window.MouseEvent("mousedown", options));
  target.dispatchEvent(new window.MouseEvent("mouseup", options));
  return target.dispatchEvent(new window.MouseEvent("click", options));
}

describe("deliverable review script: picking", () => {
  it("picks the outermost SVG, the whole table, the image and the nearest block", () => {
    const { document, api } = load();
    expect(api.pickable(document.querySelector("rect")!)).toBe(document.querySelector("svg"));
    expect(api.pickable(document.querySelector("td span")!)).toBe(document.querySelector("table"));
    expect(api.pickable(document.querySelector("img")!)).toBe(document.querySelector("img"));
    expect(api.pickable(document.querySelector("a")!)).toBe(document.querySelector("a"));
    expect(api.pickable(document.querySelector("section div")!)).toBe(document.querySelector("section div"));
    expect(api.pickable(document.body)).toBe(document.body);
  });

  it("labels what was picked so a person and the agent can tell what it is", () => {
    const { document, api } = load();
    expect(api.describe(document.querySelector("img")!)).toBe("Image: Q3 revenue chart");
    expect(api.describe(document.querySelector("svg")!)).toBe("Graphic: Costs by region");
    expect(api.describe(document.querySelector("table")!)).toBe("Table: Headcount");
    expect(api.describe(document.querySelector("figure")!)).toBe("Figure: Revenue by month");
    expect(api.describe(document.querySelector("h1")!)).toBe("Heading: Q3 board pack");
    expect(api.describe(document.querySelector("section")!)).toBe("Block: Slide two");
    expect(api.describe(document.body)).toBe("Page");

    const unnamed = load("<html><body><img src='/a/b/logo.svg#x'><p>x</p></body></html>");
    expect(unnamed.api.describe(unnamed.document.querySelector("img")!)).toBe("Image: logo.svg");
  });

  it("builds an nth-of-type path that finds the same element", () => {
    const { document, api } = load();
    const img = document.querySelector("img")!;
    expect(api.pathOf(img)).toBe("body > figure:nth-of-type(1) > img:nth-of-type(1)");
    expect(api.pathOf(document.querySelector("svg")!)).toBe("body > svg:nth-of-type(1)");
    expect(api.pathOf(document.body)).toBe("body");
    expect(api.findElement({ path: api.pathOf(img), tag: "img", label: "Image: Q3 revenue chart" })).toBe(img);
  });

  it("finds an element by its label when the page moved it, and drops a stale path", () => {
    // The chart now sits after a new paragraph and inside a div.
    const { document, api } = load(`<html><body><p>New intro</p><div><img alt="Logo"><img alt="Q3 revenue chart"></div></body></html>`);
    const chart = document.querySelectorAll("img")[1];
    expect(api.findElement({ path: "body > figure:nth-of-type(1) > img:nth-of-type(1)", tag: "img", label: "Image: Q3 revenue chart" })).toBe(chart);
    // The path still names an img but with another label: the label wins.
    expect(api.findElement({ path: "body > div:nth-of-type(1) > img:nth-of-type(1)", tag: "img", label: "Image: Q3 revenue chart" })).toBe(chart);
    // No label match: the element at the path, when its tag matches.
    expect(api.findElement({ path: "body > div:nth-of-type(1) > img:nth-of-type(1)", tag: "img", label: "Image: Gone" })).toBe(document.querySelector("img"));
    expect(api.findElement({ path: "body > p:nth-of-type(1)", tag: "img", label: "Image: Gone" })).toBeNull();
    expect(api.findElement({ path: "body > [onclick]", tag: "img", label: null })).toBeNull();
  });

  it("reports an Alt+click as an element pick and does not follow a link", () => {
    const { window, document, sent } = load();
    const link = document.querySelector("a")!;
    const followed = click(window, link, { altKey: true });
    expect(followed).toBe(false);
    expect(sent.filter((m) => m.type === "selection")).toEqual([{
      gsamReview: 1,
      type: "selection",
      kind: "element",
      quote: "Link: Accra",
      locator: { path: "body > p:nth-of-type(1) > a:nth-of-type(1)", tag: "a", label: "Link: Accra", box: null },
    }]);
  });

  it("picks on a plain click only in pick mode", () => {
    const { window, document, sent, toFrame } = load();
    click(window, document.querySelector("img")!);
    expect(sent.some((m) => m.type === "selection")).toBe(false);

    toFrame({ type: "pickMode", on: true });
    expect(document.documentElement.hasAttribute("data-gsam-picking")).toBe(true);
    click(window, document.querySelector("rect")!);
    expect(sent.filter((m) => m.type === "selection").map((m) => m.quote)).toEqual(["Graphic: Costs by region"]);

    toFrame({ type: "pickMode", on: false });
    expect(document.documentElement.hasAttribute("data-gsam-picking")).toBe(false);
  });

  it("reports a drag as an area of the block it was drawn in", () => {
    const { window, document, api, sent, toFrame } = load();
    const section = document.querySelector("section")!;
    const div = section.querySelector("div")!;
    section.getBoundingClientRect = () => ({ left: 0, top: 100, right: 400, bottom: 300, width: 400, height: 200, x: 0, y: 100, toJSON() {} });
    div.getBoundingClientRect = () => ({ left: 0, top: 100, right: 400, bottom: 120, width: 400, height: 20, x: 0, y: 100, toJSON() {} });
    document.elementFromPoint = () => div;

    expect(api.regionLocator({ left: 100, top: 150, right: 300, bottom: 250 })).toEqual({
      path: "body > section:nth-of-type(1)",
      tag: "section",
      label: "Block: Slide two",
      box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });

    toFrame({ type: "pickMode", on: true });
    div.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 150 }));
    div.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 300, clientY: 250 }));
    expect(document.querySelector("[data-gsam-review-drag]")).not.toBeNull();
    div.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 250 }));
    const picks = sent.filter((m) => m.type === "selection");
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ kind: "region", quote: "Area on Block: Slide two", locator: { tag: "section", box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } });
  });
});

describe("deliverable review script: markers", () => {
  it("draws a numbered box for element and region anchors and text marks for passages", () => {
    const { document, toFrame } = load();
    toFrame({
      type: "marks",
      marks: [
        { id: "c-1", n: 1, quote: "Revenue grew", prefix: null, suffix: null, textStart: null, sent: false, active: false },
        { id: "c-2", n: 2, kind: "element", quote: "Image: Q3 revenue chart", locator: { path: "body > figure:nth-of-type(1) > img:nth-of-type(1)", tag: "img", label: "Image: Q3 revenue chart", box: null }, sent: true, active: true },
        { id: "c-3", n: 3, kind: "region", quote: "Area on Page", locator: { path: "body", tag: "body", label: "Page", box: { x: 0, y: 0, width: 0.5, height: 0.5 } }, sent: false, active: false },
        { id: "c-4", n: 4, kind: "element", quote: "Image: Gone", locator: { path: "body > video:nth-of-type(1)", tag: "video", label: "Video: Gone", box: null }, sent: false, active: false },
      ],
    });
    expect(document.querySelector('mark[data-gsam-review="c-1"]')?.textContent).toBe("Revenue grew");
    const layer = document.querySelector("[data-gsam-review-layer]")!;
    expect(document.body.contains(layer)).toBe(false);
    const boxes = Array.from(layer.querySelectorAll("[data-gsam-review-box]"));
    expect(boxes.map((box) => box.getAttribute("data-gsam-review-box"))).toEqual(["c-2", "c-3"]);
    expect(boxes[0]!.getAttribute("data-gsam-state")).toBe("sent");
    expect(boxes[0]!.getAttribute("data-gsam-active")).toBe("true");
    expect(Array.from(layer.querySelectorAll("[data-gsam-review-badge]")).map((badge) => badge.textContent)).toEqual(["2", "3"]);

    // Redrawing replaces the old boxes rather than stacking them.
    toFrame({ type: "marks", marks: [] });
    expect(layer.querySelectorAll("[data-gsam-review-box]")).toHaveLength(0);
    expect(document.querySelector("mark[data-gsam-review]")).toBeNull();
  });

  it("scrolls to an element marker and reports a click on its badge", () => {
    const { window, document, sent, toFrame } = load();
    toFrame({
      type: "marks",
      marks: [{ id: "c-2", n: 1, kind: "element", quote: "Table: Headcount", locator: { path: "body > table:nth-of-type(1)", tag: "table", label: "Table: Headcount", box: null }, sent: false, active: false }],
    });
    const box = document.querySelector('[data-gsam-review-box="c-2"]') as HTMLElement;
    let scrolled = false;
    box.scrollIntoView = () => { scrolled = true; };
    toFrame({ type: "scrollTo", id: "c-2" });
    expect(scrolled).toBe(true);

    document.querySelector('[data-gsam-review-layer] [data-gsam-review-badge="c-2"]')!
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(sent).toContainEqual({ gsamReview: 1, type: "focus", id: "c-2" });
  });
});
