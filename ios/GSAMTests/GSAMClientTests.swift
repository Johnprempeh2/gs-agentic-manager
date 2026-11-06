import Foundation
import Testing
@testable import GSAM

@Suite struct GSAMClientTests {
    let transport = FakeTransport()
    var client: GSAMClient { GSAMClient(baseURL: Fixtures.baseURL, token: "board-token", transport: transport) }

    @Test func sendsTheTokenAsABearerHeader() async throws {
        transport.on("GET /api/cli-auth/me", json: Fixtures.account)

        let account = try await client.account()

        #expect(account.userId == "u1")
        #expect(account.companyIds == ["c1", "c2"])
        let request = try #require(transport.sent.first)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer board-token")
        #expect(request.url?.absoluteString == "https://gsam.example.ts.net:3100/api/cli-auth/me")
    }

    @Test func readsOnlyAccessibleCompanies() async throws {
        transport.on("GET /api/companies", json: Fixtures.companies)

        let companies = try await client.companies()

        #expect(companies.map(\.name) == ["Greatstone International", "Second Co"])
        #expect(transport.sent.first?.url?.query() == "scope=accessible")
    }

    @Test func decodesTheAttentionFeed() async throws {
        transport.on("GET /api/companies/c1/attention", json: Fixtures.attention)

        let feed = try await client.attention(companyId: "c1")

        #expect(transport.sent.first?.url?.query() == "sort=decide")
        let item = try #require(feed.items.first)
        #expect(item.severity == .high)
        #expect(item.subject.title == "Release to live")
        #expect(item.activityAt == ISO8601.parse("2026-11-06T08:30:00Z"))
        #expect(client.webURL(for: item.subject.href)?.absoluteString == "https://gsam.example.ts.net:3100/GRE/approvals/ap1")
    }

    @Test func decodesBlockedWork() async throws {
        transport.on("GET /api/companies/c1/blocked-work", json: Fixtures.blocked)

        let overview = try await client.blockedWork(companyId: "c1")

        #expect(overview.totalBlocked == 1)
        let item = try #require(overview.items.first)
        #expect(item.issue.identifier == "GRE-4196")
        #expect(item.owner.type == .board)
        #expect(item.waitingSince == ISO8601.parse("2026-11-03T09:00:00Z"))
    }

    @Test func createsASignInChallengeWithoutAToken() async throws {
        transport.on("POST /api/cli-auth/challenges", json: Fixtures.challenge, status: 201)
        let anonymous = GSAMClient(baseURL: Fixtures.baseURL, transport: transport)

        let challenge = try await anonymous.createSignInChallenge()

        let request = try #require(transport.sent.first)
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try JSONDecoder().decode([String: String].self, from: try #require(request.httpBody))
        #expect(body["clientName"] == "GSAM iPhone")
        #expect(challenge.boardApiToken == "board-token-from-challenge")
        // The approval page is opened on the address John typed, not the
        // loopback address the server may report.
        #expect(anonymous.approvalURL(for: challenge)?.absoluteString
            == "https://gsam.example.ts.net:3100/cli-auth/9f1c2a7e-0000-4000-8000-000000000001?token=challenge-secret-0123456789")
    }

    @Test func pollsTheChallengeWithItsSecret() async throws {
        transport.on("POST /api/cli-auth/challenges", json: Fixtures.challenge, status: 201)
        transport.on("GET /api/cli-auth/challenges/", json: #"{"status":"pending"}"#)
        let challenge = try await client.createSignInChallenge()

        let status = try await client.signInChallengeStatus(challenge)

        #expect(status.status == .pending)
        #expect(transport.sent.last?.url?.query() == "token=challenge-secret-0123456789")
    }

    @Test(arguments: [
        (401, GSAMError.signedOut),
        (403, GSAMError.forbidden),
        (500, GSAMError.server(status: 500, message: "Database is down")),
    ])
    func mapsErrorStatuses(status: Int, expected: GSAMError) async throws {
        transport.on("GET /api/cli-auth/me", json: #"{"error":"Database is down"}"#, status: status)

        await #expect(throws: expected) { try await client.account() }
    }

    @Test func aNetworkFailureSaysTheServerCannotBeReached() async throws {
        transport.on("GET /api/cli-auth/me", FakeTransport.Reply(error: URLError(.cannotFindHost)))

        await #expect(throws: GSAMError.cannotReach) { try await client.account() }
        #expect(GSAMError.cannotReach.localizedDescription.contains("Cannot reach GSAM"))
    }

    @Test func anUnexpectedShapeIsReportedNotHidden() async throws {
        transport.on("GET /api/companies/c1/blocked-work", json: #"{"unexpected":true}"#)

        await #expect(throws: GSAMError.unreadableResponse) { try await client.blockedWork(companyId: "c1") }
    }
}
