import { describe, expect, it } from "vitest";
import { createPipedriveClient, type PipedriveFetch } from "../services/crm-sync-pipedrive.js";

describe("Pipedrive website lead client", () => {
  it("creates a linked person and lead with a stable origin marker", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetch: PipedriveFetch = async (url, init) => {
      requests.push({ url, method: init.method, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
      return {
        status: 201,
        headers: { get: () => null },
        json: async () => ({ success: true, data: url.includes("/persons") ? { id: 42 } : { id: "lead-42" } }),
      };
    };
    const client = createPipedriveClient({ token: "test-token", authKind: "api_key", fetch });
    const person = await client.createPerson({ name: "Jo Example", email: "jo@example.test" });
    const lead = await client.createLead({ title: "Jo Example: website enquiry", personId: person.id, originId: "gsam:website:abc" });
    expect(lead.id).toBe("lead-42");
    expect(requests).toMatchObject([
      { method: "POST", body: { name: "Jo Example", emails: [{ value: "jo@example.test", primary: true }] } },
      { method: "POST", body: { person_id: 42, origin_id: "gsam:website:abc" } },
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/v2/persons", "/api/v1/leads"]);
  });
});
