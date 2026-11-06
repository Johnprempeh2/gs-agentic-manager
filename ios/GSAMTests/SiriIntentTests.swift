import Foundation
import Testing
@testable import GSAM

/// Each Siri command: the phrase Siri listens for, the API calls it makes and
/// what Siri says back. The intents run against a fake GSAM server.
@Suite struct SiriIntentTests {
    let transport = FakeTransport()
    var commands: SiriCommands {
        SiriCommands(
            client: GSAMClient(baseURL: Fixtures.baseURL, token: "board-token", transport: transport),
            now: { ISO8601.parse("2026-11-06T10:00:00Z")! }
        )
    }

    /// Requests sent, as "METHOD path?query", in a stable order.
    var sentRequests: [String] {
        transport.sent.map { request in
            let query = request.url?.query().map { "?\($0)" } ?? ""
            return "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")\(query)"
        }.sorted()
    }

    // MARK: Phrases

    /// The phrases Xcode compiled into the app, read back from the metadata
    /// Siri uses, so a phrase that does not build into the app fails here.
    @Test func theAppRegistersTheThreePhrases() throws {
        let metadata = Bundle.main.bundleURL.appending(path: "Metadata.appintents/extract.actionsdata")
        let text = try String(contentsOf: metadata, encoding: .utf8)

        for phrase in [
            "${applicationName} status",
            "What needs my approval in ${applicationName}",
            "Add a ${applicationName} task",
        ] {
            #expect(text.contains(phrase), "Missing phrase \(phrase) in \(text.prefix(3000))")
        }
        #expect(String(localized: GSAMStatusIntent.title) == "GSAM status")
        #expect(String(localized: NeedsApprovalIntent.title) == "What needs my approval")
        #expect(String(localized: AddTaskIntent.title) == "Add a GSAM task")
    }

    // MARK: "GSAM status"

    @Test func statusCountsEveryCompanyAndNamesTheLongestWait() async throws {
        transport.on("GET /api/companies/c1/attention", json: Fixtures.attention)
        transport.on("GET /api/companies/c2/attention", json: Fixtures.emptyAttention)
        transport.on("GET /api/companies/c1/blocked-work", json: Fixtures.blocked)
        transport.on("GET /api/companies/c2/blocked-work", json: Fixtures.emptyBlocked)
        transport.on("GET /api/companies", json: Fixtures.companies)

        let answer = try await GSAMStatusIntent().answer(using: commands)

        #expect(answer == "1 item needs you and 1 task is blocked. "
            + "The longest wait is GRE-4196, Buy the Apple Developer account, blocked for 3 days.")
        #expect(sentRequests == [
            "GET /api/companies/c1/attention?sort=decide",
            "GET /api/companies/c1/blocked-work",
            "GET /api/companies/c2/attention?sort=decide",
            "GET /api/companies/c2/blocked-work",
            "GET /api/companies?scope=accessible",
        ])
        #expect(transport.sent.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer board-token" })
    }

    @Test func statusWhenNothingWaits() async throws {
        transport.on("/attention", json: Fixtures.emptyAttention)
        transport.on("/blocked-work", json: Fixtures.emptyBlocked)
        transport.on("GET /api/companies", json: Fixtures.companies)

        let answer = try await GSAMStatusIntent().answer(using: commands)

        #expect(answer == "Nothing needs you and no tasks are blocked.")
    }

    // MARK: "What needs my approval"

    @Test func needsApprovalReadsTheMostSevereItemsFirstWithTheirCompany() async throws {
        transport.on("GET /api/companies/c1/attention", json: Fixtures.attention)
        transport.on("GET /api/companies/c2/attention", json: Self.feed(company: "c2", total: 1, items: [
            ("Budget over limit", "critical", "Spend passed the monthly cap"),
        ]))
        transport.on("GET /api/companies", json: Fixtures.companies)

        let answer = try await NeedsApprovalIntent().answer(using: commands)

        #expect(answer == "2 items need you. "
            + "1. Budget over limit, in Second Co: Spend passed the monthly cap. "
            + "2. Release to live, in Greatstone International: Everest asks you to approve the release.")
        #expect(sentRequests == [
            "GET /api/companies/c1/attention?sort=decide",
            "GET /api/companies/c2/attention?sort=decide",
            "GET /api/companies?scope=accessible",
        ])
    }

    @Test func needsApprovalReadsThreeAndCountsTheRest() async throws {
        transport.on("GET /api/companies/c1/attention", json: Self.feed(company: "c1", total: 6, items: [
            ("First", "medium", "One."),
            ("Second", "medium", "Two."),
            ("Third", "medium", "Three."),
            ("Fourth", "medium", "Four."),
        ]))
        transport.on("GET /api/companies/c2/attention", json: Fixtures.emptyAttention)
        transport.on("GET /api/companies", json: Fixtures.companies)

        let answer = try await NeedsApprovalIntent().answer(using: commands)

        #expect(answer == "6 items need you. 1. First: One. 2. Second: Two. 3. Third: Three. And 3 more in the app.")
    }

    @Test func needsApprovalWhenTheInboxIsEmpty() async throws {
        transport.on("/attention", json: Fixtures.emptyAttention)
        transport.on("GET /api/companies", json: Fixtures.companies)

        let answer = try await NeedsApprovalIntent().answer(using: commands)

        #expect(answer == "Nothing needs your approval in GSAM.")
    }

    // MARK: "Add a GSAM task"

    func addTaskIntent(title: String) -> AddTaskIntent {
        var intent = AddTaskIntent()
        intent.taskTitle = title
        intent.company = CompanyEntity(id: "c2", name: "Second Co")
        return intent
    }

    @Test func addTaskCreatesARealIssueInTheChosenCompany() async throws {
        transport.on(
            "POST /api/companies/c2/issues",
            json: #"{"id":"i9","companyId":"c2","identifier":"SEC-12","title":"Call the bank","status":"todo"}"#,
            status: 201
        )

        let answer = try await addTaskIntent(title: "  Call the bank ").answer(using: commands)

        #expect(answer == "Added SEC-12 in Second Co: Call the bank.")
        let request = try #require(transport.sent.only)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path() == "/api/companies/c2/issues")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer board-token")
        let body = try JSONDecoder().decode([String: String].self, from: try #require(request.httpBody))
        #expect(body == ["title": "Call the bank"])
    }

    @Test func addTaskSaysWhenTheTaskAlreadyExists() async throws {
        transport.on(
            "POST /api/companies/c2/issues",
            json: #"{"id":"i9","identifier":"SEC-12","title":"Call the bank","deduplicated":true,"deduplicationReason":"recent_open_title"}"#
        )

        let answer = try await addTaskIntent(title: "Call the bank").answer(using: commands)

        #expect(answer == "SEC-12 already exists: Call the bank. I did not add it again.")
    }

    @Test func addTaskWithAnEmptyTitleSendsNothing() async throws {
        await #expect(throws: SiriError.emptyTitle) {
            try await addTaskIntent(title: "   ").answer(using: commands)
        }
        #expect(transport.sent.isEmpty)
    }

    @Test func companyChoicesAreTheCompaniesTheLoginCanSee() async throws {
        transport.on("GET /api/companies", json: Fixtures.companies)

        let companies = try await commands.companies().map { CompanyEntity($0) }

        #expect(companies == [
            CompanyEntity(id: "c1", name: "Greatstone International"),
            CompanyEntity(id: "c2", name: "Second Co"),
        ])
        #expect(transport.sent.first?.url?.query() == "scope=accessible")
    }

    // MARK: Failures Siri says out loud

    @Test func anEndedSignInTellsJohnToSignInAgain() async throws {
        transport.on("GET /api/companies", json: #"{"error":"Unauthorized"}"#, status: 401)

        await #expect(throws: SiriError(message: "Your GSAM sign-in has ended. Open GSAM and sign in again.")) {
            try await GSAMStatusIntent().answer(using: commands)
        }
    }

    @Test func anUnreachableServerSaysSo() async throws {
        transport.on("GET /api/companies", FakeTransport.Reply(error: URLError(.cannotConnectToHost)))

        await #expect(throws: SiriError(message: GSAMError.cannotReach.localizedDescription)) {
            try await NeedsApprovalIntent().answer(using: commands)
        }
    }

    @Test func withoutASavedSignInSiriAsksJohnToSignIn() throws {
        let defaults = try #require(UserDefaults(suiteName: "gsam.tests.\(UUID().uuidString)"))
        defaults.set(Fixtures.baseURL.absoluteString, forKey: SessionStore.serverAddressKey)

        #expect(throws: SiriError.notSignedIn) {
            try SiriCommands.live(tokenStore: InMemoryTokenStore(), defaults: defaults, transport: transport)
        }

        let live = try SiriCommands.live(
            tokenStore: InMemoryTokenStore(token: "saved-token"), defaults: defaults, transport: transport
        )
        #expect(live.client.baseURL == Fixtures.baseURL)
        #expect(live.client.token == "saved-token")
    }

    // MARK: Fixtures

    static func feed(company: String, total: Int, items: [(title: String, severity: String, why: String)]) -> String {
        let rows = items.enumerated().map { index, item in
            """
            {"id":"\(company)-a\(index)","companyId":"\(company)","sourceKind":"approval","severity":"\(item.severity)",
             "activityAt":"2026-11-06T08:00:00.000Z","decideBy":null,"whyNow":"\(item.why)",
             "subject":{"kind":"approval","id":"\(company)-ap\(index)","title":"\(item.title)","identifier":null,"status":"pending","href":null}}
            """
        }
        return #"{"companyId":"\#(company)","totalCount":\#(total),"items":[\#(rows.joined(separator: ","))]}"#
    }
}

private extension Array {
    /// The single element, or nil when there are none or several.
    var only: Element? { count == 1 ? first : nil }
}
