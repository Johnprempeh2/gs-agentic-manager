import Foundation
import Testing
@testable import GSAM

@MainActor
@Suite struct SessionStoreTests {
    let transport = FakeTransport()
    let tokens = InMemoryTokenStore()
    let defaults: UserDefaults

    init() {
        let suite = "gsam.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        defaults.set(Fixtures.baseURL.absoluteString, forKey: SessionStore.serverAddressKey)
    }

    func makeStore() -> SessionStore {
        SessionStore(tokenStore: tokens, transport: transport, defaults: defaults, sleep: { _ in })
    }

    func serveSignedInReads() {
        transport.on("GET /api/cli-auth/me", json: Fixtures.account)
        transport.on("GET /api/companies", json: Fixtures.companies)
    }

    @Test func withoutASavedTokenItShowsSignIn() async {
        let store = makeStore()

        await store.restore()

        #expect(store.state == .signedOut(message: nil))
        #expect(transport.sent.isEmpty)
    }

    @Test func approvedChallengeSavesTheTokenAndSignsIn() async throws {
        transport.on("POST /api/cli-auth/challenges", json: Fixtures.challenge, status: 201)
        transport.on(
            "GET /api/cli-auth/challenges/",
            .init(body: #"{"status":"pending"}"#),
            .init(error: URLError(.networkConnectionLost)),
            .init(body: #"{"status":"approved"}"#)
        )
        serveSignedInReads()
        let store = makeStore()

        await store.startSignIn()

        guard case let .signedIn(session) = store.state else {
            Issue.record("Expected signed in, got \(store.state)")
            return
        }
        #expect(session.companies.count == 2)
        #expect(session.client.token == "board-token-from-challenge")
        #expect(try tokens.read() == "board-token-from-challenge")
        let me = try #require(transport.sent.first { $0.url?.path() == "/api/cli-auth/me" })
        #expect(me.value(forHTTPHeaderField: "Authorization") == "Bearer board-token-from-challenge")
    }

    @Test func aCancelledChallengeSaysSoAndSavesNothing() async throws {
        transport.on("POST /api/cli-auth/challenges", json: Fixtures.challenge, status: 201)
        transport.on("GET /api/cli-auth/challenges/", json: #"{"status":"cancelled"}"#)
        let store = makeStore()

        await store.startSignIn()

        #expect(store.state == .signedOut(message: SignInError.cancelled.localizedDescription))
        #expect(try tokens.read() == nil)
    }

    @Test func anExpiredChallengeTimesOut() async throws {
        transport.on("POST /api/cli-auth/challenges", json: Fixtures.expiredChallenge, status: 201)
        let store = makeStore()

        await store.startSignIn()

        #expect(store.state == .signedOut(message: SignInError.expired.localizedDescription))
        #expect(try tokens.read() == nil)
    }

    @Test(arguments: [
        ("", SignInError.missingAddress),
        ("not a url", SignInError.invalidAddress),
        ("http://gsam.example.ts.net:3100", SignInError.insecureAddress),
    ])
    func rejectsABadServerAddress(address: String, expected: SignInError) async {
        let store = makeStore()
        store.serverAddress = address

        await store.startSignIn()

        #expect(store.state == .signedOut(message: expected.localizedDescription))
        #expect(transport.sent.isEmpty)
    }

    @Test func restoresASavedSignIn() async throws {
        try tokens.save("saved-token")
        serveSignedInReads()
        let store = makeStore()

        await store.restore()

        guard case let .signedIn(session) = store.state else {
            Issue.record("Expected signed in, got \(store.state)")
            return
        }
        #expect(session.account.user?.name == "John")
    }

    @Test func aRevokedTokenIsDeletedOnRestore() async throws {
        try tokens.save("revoked-token")
        transport.on("GET /api/cli-auth/me", json: #"{"error":"Unauthorized"}"#, status: 401)
        transport.on("GET /api/companies", json: #"{"error":"Unauthorized"}"#, status: 401)
        let store = makeStore()

        await store.restore()

        #expect(store.state == .signedOut(message: GSAMError.signedOut.localizedDescription))
        #expect(try tokens.read() == nil)
    }

    @Test func anUnreachableServerKeepsTheToken() async throws {
        try tokens.save("saved-token")
        transport.on("GET /api/", .init(error: URLError(.notConnectedToInternet)))
        let store = makeStore()

        await store.restore()

        #expect(store.state == .unreachable(message: GSAMError.cannotReach.localizedDescription))
        #expect(try tokens.read() == "saved-token")
    }

    @Test func signOutRevokesAndDeletesTheToken() async throws {
        try tokens.save("saved-token")
        serveSignedInReads()
        transport.on("POST /api/cli-auth/revoke-current", json: #"{"revoked":true}"#)
        let store = makeStore()
        await store.restore()

        await store.signOut()

        #expect(store.state == .signedOut(message: nil))
        #expect(try tokens.read() == nil)
        #expect(transport.sent.contains { $0.url?.path() == "/api/cli-auth/revoke-current" })
    }
}
