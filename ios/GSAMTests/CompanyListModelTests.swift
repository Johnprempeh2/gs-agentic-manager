import Foundation
import Testing
@testable import GSAM

@MainActor
@Suite struct CompanyListModelTests {
    let transport = FakeTransport()

    var session: Session {
        let decoder = GSAMClient.decoder
        return Session(
            client: GSAMClient(baseURL: Fixtures.baseURL, token: "board-token", transport: transport),
            account: try! decoder.decode(Account.self, from: Data(Fixtures.account.utf8)),
            companies: try! decoder.decode([Company].self, from: Data(Fixtures.companies.utf8))
        )
    }

    @Test func startsLoading() {
        #expect(CompanyListModel.needsYou(session: session).state == .loading)
    }

    @Test func keepsOnlyCompaniesWithItems() async throws {
        transport.on("GET /api/companies/c1/attention", json: Fixtures.attention)
        transport.on("GET /api/companies/c2/attention", json: Fixtures.emptyAttention)
        let model = CompanyListModel.needsYou(session: session)

        await model.load()

        guard case let .loaded(sections) = model.state else {
            Issue.record("Expected loaded, got \(model.state)")
            return
        }
        #expect(sections.map(\.company.name) == ["Greatstone International"])
        #expect(model.totalCount == 1)
    }

    @Test func nothingAnywhereIsEmpty() async {
        transport.on("/blocked-work", json: Fixtures.emptyBlocked)
        let model = CompanyListModel.blocked(session: session)

        await model.load()

        #expect(model.state == .loaded([]))
        #expect(model.totalCount == 0)
    }

    @Test func loadsBlockedWorkPerCompany() async throws {
        transport.on("GET /api/companies/c1/blocked-work", json: Fixtures.blocked)
        transport.on("GET /api/companies/c2/blocked-work", json: Fixtures.blocked)
        let model = CompanyListModel.blocked(session: session)

        await model.load()

        guard case let .loaded(sections) = model.state else {
            Issue.record("Expected loaded, got \(model.state)")
            return
        }
        #expect(sections.map(\.company.id) == ["c1", "c2"])
        #expect(sections.first?.items.first?.issue.title == "Buy the Apple Developer account")
    }

    @Test func aFailureShowsTheReasonAndRetryRecovers() async {
        transport.on("GET /api/companies/c1/attention", .init(error: URLError(.timedOut)), .init(body: Fixtures.attention))
        transport.on("GET /api/companies/c2/attention", json: Fixtures.emptyAttention)
        let model = CompanyListModel.needsYou(session: session)

        await model.load()
        #expect(model.state == .failed(message: GSAMError.cannotReach.localizedDescription))

        await model.load()
        #expect(model.totalCount == 1)
    }

    @Test func anEndedSessionSignsOut() async {
        transport.on("/attention", json: #"{"error":"Unauthorized"}"#, status: 401)
        var ended = false
        let model = CompanyListModel.needsYou(session: session, onSessionEnded: { ended = true })

        await model.load()

        #expect(ended)
    }
}
