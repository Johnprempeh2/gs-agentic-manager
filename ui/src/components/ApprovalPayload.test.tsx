// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApprovalPayloadRenderer, approvalActionLabels, approvalLabel, permissionKeyLabel, scopeTypeLabel } from "./ApprovalPayload";
import { ThemeProvider } from "../context/ThemeContext";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Needs your approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
              recommendedAction: "Approve the frog reply.",
              nextActionOnApproval: "Post the frog comment on the issue.",
              risks: ["The frog might be too powerful."],
              proposedComment: "(o)<",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("renders markdown in board approval prose fields", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "**Bold** and `code` and [a link](https://example.com).",
              recommendedAction: "Approve the **frog** reply.",
              nextActionOnApproval: "Post the `frog` comment.",
              risks: ["The **frog** might be too powerful."],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(4);

    const summary = bodies[0];
    expect(summary.querySelector("strong")?.textContent).toBe("Bold");
    expect(summary.querySelector("code")?.textContent).toBe("code");
    const link = summary.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.textContent).toBe("a link");

    // The raw markdown characters must not survive into the rendered text.
    expect(container.textContent).not.toContain("**Bold**");
    expect(container.textContent).not.toContain("[a link](https://example.com)");

    expect(bodies[1].querySelector("strong")?.textContent).toBe("frog");
    expect(bodies[2].querySelector("code")?.textContent).toBe("frog");
    expect(bodies[3].querySelector("strong")?.textContent).toBe("frog");

    act(() => {
      root.unmount();
    });
  });

  it("does not nest a second bullet when a risk is authored as a markdown list item", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              risks: [
                "- **Leading dash** risk.",
                "* Leading star risk.",
                "• Leading dot risk.",
                "1. Leading number risk.",
                "2) Leading paren risk.",
              ],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(5);
    for (const body of bodies) {
      expect(body.querySelector("ul")).toBeNull();
      expect(body.querySelector("ol")).toBeNull();
      expect(body.querySelector("li")).toBeNull();
    }

    expect(bodies[0].querySelector("strong")?.textContent).toBe("Leading dash");
    expect(container.textContent).toContain("Leading star risk.");
    expect(container.textContent).toContain("Leading dot risk.");
    expect(container.textContent).toContain("Leading number risk.");
    expect(container.textContent).toContain("Leading paren risk.");
    expect(container.textContent).not.toContain("- **Leading dash**");

    act(() => {
      root.unmount();
    });
  });

  it("renders every risk when two entries collapse to the same text after marker stripping", () => {
    const root = createRoot(container);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      act(() => {
        root.render(
          <ThemeProvider>
            <ApprovalPayloadRenderer
              type="request_board_approval"
              payload={{
                title: "Reply with an ASCII frog",
                risks: ["- Low probability", "* Low probability"],
              }}
            />
          </ThemeProvider>,
        );
      });

      expect(container.querySelectorAll(".paperclip-markdown").length).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
      act(() => {
        root.unmount();
      });
    }
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            hidePrimaryTitle
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
  it("names permission requests and budget scopes in plain words", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="permission_grant"
            payload={{ agentName: "Designer", permissionKey: "tasks:assign" }}
          />
          <ApprovalPayloadRenderer
            type="budget_override_required"
            payload={{ scopeType: "company", windowKind: "lifetime" }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Assign tasks");
    expect(container.textContent).not.toContain("tasks:assign");
    expect(container.textContent).toContain("The whole organisation");

    act(() => {
      root.unmount();
    });
  });

  it("tucks the raw payload of an unknown approval type behind Technical details", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer type="something_new" payload={{ mystery: 42 }} />
        </ThemeProvider>,
      );
    });

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details?.textContent).toContain("\"mystery\": 42");

    act(() => {
      root.unmount();
    });
  });
});

describe("permissionKeyLabel and scopeTypeLabel", () => {
  it("falls back to a humanised key and the raw scope", () => {
    expect(permissionKeyLabel("memory:read")).toBe("Read organisation memory");
    expect(permissionKeyLabel("widgets:do_thing")).toBe("Widgets: do thing");
    expect(scopeTypeLabel("agent")).toBe("An agent");
    expect(scopeTypeLabel("team")).toBe("team");
  });
});

// GRE-2109: an agent's Publish proposal (GRE-2107 copy section 8).
describe("website_publish approvals", () => {
  it("reads as Approve and Publish / Not now and shows what goes live", () => {
    expect(approvalActionLabels("website_publish")).toMatchObject({ approve: "Approve and Publish", reject: "Not now" });
    expect(approvalActionLabels("permission_grant")).toMatchObject({ approve: "Grant", reject: "Deny" });
    expect(approvalLabel("website_publish", { title: "Quill proposes a Publish" })).toBe("Publish proposal: Quill proposes a Publish");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
          <ThemeProvider>
            <ApprovalPayloadRenderer
              type="website_publish"
              payload={{
                siteId: "s1",
                siteName: "Example site",
                summary: "1 change is ready. Approving starts a Publish in your name. It costs about 15 credits.",
                changes: [{
                  kind: "page", id: "p1", revisionId: "r1", label: "About", path: "/about",
                  changeLines: ["Edited Hero: title"], seoTitle: "About us", seoDescription: null,
                }],
              }}
            />
          </ThemeProvider>
        ,
      );
    });
    expect(container.textContent).toContain("Example site");
    expect(container.textContent).toContain("Approving starts a Publish in your name");
    expect(container.textContent).toContain("About");
    expect(container.textContent).toContain("/about");
    expect(container.textContent).toContain("Edited Hero: title");
    expect(container.textContent).toContain("SEO: About us");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/website/sites/s1/pages/p1/design");
    act(() => root.unmount());
    container.remove();
  });
});

describe("commerce_publish_request approvals (GRE-4089)", () => {
  it("names the record, the change and who asked, and says a changed record voids it", () => {
    expect(approvalActionLabels("commerce_publish_request")).toMatchObject({ approve: "Approve and publish", reject: "Reject" });
    expect(approvalLabel("commerce_publish_request", { title: 'Publish offering "Words"' })).toBe('Catalogue publish request: Publish offering "Words"');

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="commerce_publish_request"
            payload={{
              siteName: "Example site", resource: "offerings", itemName: "Words", requestedBy: "Lintel", note: "Priced and checked",
              before: { status: "draft", rowVersion: 3 }, after: { status: "published" }, item: { name: "Words", slug: "words" },
            }}
          />
        </ThemeProvider>,
      );
    });
    expect(container.textContent).toContain("offerings Words");
    expect(container.textContent).toContain("draft → published");
    expect(container.textContent).toContain("Lintel");
    expect(container.textContent).toContain("Priced and checked");
    expect(container.textContent).toContain("the card is void and nothing is published");
    act(() => root.unmount());
    container.remove();
  });
});

describe("website_access_change approvals (GRE-4085)", () => {
  it("names the change and who asked, and says a changed person voids it", () => {
    expect(approvalActionLabels("website_access_change")).toMatchObject({ approve: "Approve and change", reject: "Reject" });
    expect(approvalLabel("website_access_change", { title: "Add Ed Editor as portal approver" })).toBe("Access change request: Add Ed Editor as portal approver");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="website_access_change"
            payload={{ siteName: "Example site", beforeText: "not a portal approver", afterText: 'portal approver: "Sales lead"',
              requestedBy: "Lintel", note: "Ed runs sales now" }}
          />
        </ThemeProvider>,
      );
    });
    expect(container.textContent).toContain('not a portal approver → portal approver: "Sales lead"');
    expect(container.textContent).toContain("Lintel");
    expect(container.textContent).toContain("Ed runs sales now");
    expect(container.textContent).toContain("the card is void and nothing is changed");
    act(() => root.unmount());
    container.remove();
  });
});
