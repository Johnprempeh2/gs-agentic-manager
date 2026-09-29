import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectionGrant } from "@greatstone/shared";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import type { AiConnectionSummary } from "./model";

// GRE-43: a Claude subscription saved before GRE-15 has no credential record.
// The live one is paused with no unavailable reason, so the page said nothing.
const legacy: AiConnectionSummary = {
  id: "b65cf471-0000-4000-8000-000000000000",
  grantId: "11111111-0000-4000-8000-000000000000",
  companyId: "22222222-0000-4000-8000-000000000000",
  provider: "anthropic",
  method: "subscription",
  name: "My Claude subscription",
  ownership: "personal",
  ownerUserId: "user-1",
  isDefault: true,
  status: "needs_attention",
};
const render = (account: AiConnectionSummary) =>
  renderToStaticMarkup(
    <AiConnectionAccountControls
      account={account}
      grant={{} as ConnectionGrant}
      currentUserId="user-1"
      readOnly
      onMakeDefault={() => {}}
      onReconnect={() => {}}
      onRevoke={() => {}}
    />,
  );

describe("AiConnectionAccountControls credential line (GRE-43)", () => {
  it("says the expiry is unknown for a paused Claude subscription with no credential record", () => {
    const html = render(legacy);
    expect(html).toContain("Default unavailable");
    expect(html).toContain("Token expiry unknown");
    expect(html).toContain("Reconnect to track it");
  });
  it("shows the unavailable reason instead when there is one", () => {
    const html = render({ ...legacy, unavailableReason: "Reconnect with a separate sign-in." });
    expect(html).toContain("Reconnect with a separate sign-in.");
    expect(html).not.toContain("Token expiry unknown");
  });
});
