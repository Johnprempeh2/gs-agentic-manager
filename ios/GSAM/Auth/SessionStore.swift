import Foundation
import Observation

/// A signed-in GSAM session: who John is, which companies he can see, and a
/// client that sends his token.
struct Session: Equatable, Sendable {
    let client: GSAMClient
    let account: Account
    let companies: [Company]

    static func == (lhs: Session, rhs: Session) -> Bool {
        lhs.client.baseURL == rhs.client.baseURL && lhs.account == rhs.account && lhs.companies == rhs.companies
    }
}

/// Signs in with the GSAM login, keeps the token in the token store, and
/// signs out. The sign-in is the challenge flow the gsam CLI uses: the app
/// asks for a challenge, John approves it on the GSAM sign-in page, and the
/// app polls until the server says approved.
@MainActor
@Observable
final class SessionStore {
    enum State: Equatable {
        case restoring
        case signedOut(message: String?)
        case waitingForApproval(URL)
        case signedIn(Session)
        /// A saved sign-in exists, but the server did not answer.
        case unreachable(message: String)
    }

    private(set) var state: State = .restoring
    var serverAddress: String

    @ObservationIgnored private let tokenStore: TokenStore
    @ObservationIgnored private let transport: HTTPTransport
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var pendingChallenge: (client: GSAMClient, challenge: CLIAuthChallenge)?

    static let serverAddressKey = "gsam.serverAddress"

    init(
        tokenStore: TokenStore = KeychainTokenStore(),
        transport: HTTPTransport = URLSession.shared,
        defaults: UserDefaults = .standard,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.tokenStore = tokenStore
        self.transport = transport
        self.defaults = defaults
        self.sleep = sleep
        serverAddress = defaults.string(forKey: Self.serverAddressKey) ?? ""
    }

    /// The server address John typed, as a URL, or nil with a reason.
    func validatedServerURL() -> Result<URL, SignInError> {
        Self.serverURL(from: serverAddress)
    }

    /// Siri reads the saved address with this too, outside the app's screens.
    nonisolated static func serverURL(from address: String) -> Result<URL, SignInError> {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .failure(.missingAddress) }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), url.host != nil else {
            return .failure(.invalidAddress)
        }
        guard scheme == "https" else { return .failure(.insecureAddress) }
        return .success(url)
    }

    // MARK: Restore

    func restore() async {
        guard case let .success(url) = validatedServerURL(), let token = try? tokenStore.read() else {
            state = .signedOut(message: nil)
            return
        }
        await loadSession(client: GSAMClient(baseURL: url, token: token, transport: transport))
    }

    private func loadSession(client: GSAMClient) async {
        do {
            async let account = client.account()
            async let companies = client.companies()
            state = try await .signedIn(Session(client: client, account: account, companies: companies))
        } catch GSAMError.signedOut {
            try? tokenStore.delete()
            state = .signedOut(message: GSAMError.signedOut.localizedDescription)
        } catch {
            state = .unreachable(message: error.localizedDescription)
        }
    }

    // MARK: Sign in

    func startSignIn() async {
        cancelPolling()
        let url: URL
        switch validatedServerURL() {
        case let .success(valid):
            url = valid
            defaults.set(serverAddress, forKey: Self.serverAddressKey)
        case let .failure(reason):
            state = .signedOut(message: reason.localizedDescription)
            return
        }
        let client = GSAMClient(baseURL: url, transport: transport)
        let challenge: CLIAuthChallenge
        do {
            challenge = try await client.createSignInChallenge()
        } catch {
            state = .signedOut(message: error.localizedDescription)
            return
        }
        guard let approvalURL = client.approvalURL(for: challenge) else {
            state = .signedOut(message: GSAMError.unreadableResponse.localizedDescription)
            return
        }
        pendingChallenge = (client, challenge)
        state = .waitingForApproval(approvalURL)
        pollTask = Task { await self.poll(client: client, challenge: challenge) }
        await pollTask?.value
    }

    private func poll(client: GSAMClient, challenge: CLIAuthChallenge) async {
        let interval = Duration.milliseconds(max(1000, challenge.suggestedPollIntervalMs ?? 1000))
        while !Task.isCancelled {
            if Date() >= challenge.expiresAt {
                finishPolling(.signedOut(message: SignInError.expired.localizedDescription))
                return
            }
            do {
                try await sleep(interval)
            } catch {
                return
            }
            let status: CLIAuthChallengeStatus.Status
            do {
                status = try await client.signInChallengeStatus(challenge).status
            } catch is CancellationError {
                return
            } catch {
                // A dropped connection or a rate limit while John is on the
                // approval page: keep waiting until the challenge expires.
                continue
            }
            guard !Task.isCancelled else { return }
            switch status {
            case .pending:
                continue
            case .approved:
                await completeSignIn(client: client.withToken(challenge.boardApiToken))
                return
            case .cancelled:
                finishPolling(.signedOut(message: SignInError.cancelled.localizedDescription))
                return
            case .expired:
                finishPolling(.signedOut(message: SignInError.expired.localizedDescription))
                return
            }
        }
    }

    private func completeSignIn(client: GSAMClient) async {
        pendingChallenge = nil
        guard let token = client.token else { return }
        do {
            try tokenStore.save(token)
        } catch {
            state = .signedOut(message: SignInError.keychain.localizedDescription)
            return
        }
        await loadSession(client: client)
    }

    private func finishPolling(_ next: State) {
        pendingChallenge = nil
        state = next
    }

    private func cancelPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// John closed the approval page without approving.
    func cancelSignIn() async {
        cancelPolling()
        let pending = pendingChallenge
        pendingChallenge = nil
        state = .signedOut(message: nil)
        if let pending {
            try? await pending.client.cancelSignInChallenge(pending.challenge)
        }
    }

    // MARK: Sign out

    func signOut() async {
        cancelPolling()
        if case let .signedIn(session) = state {
            // Best effort: the token is gone from the phone either way.
            try? await session.client.revokeCurrentToken()
        }
        try? tokenStore.delete()
        state = .signedOut(message: nil)
    }

    /// A screen got 401: the token expired or was revoked on the server.
    func sessionEnded() {
        try? tokenStore.delete()
        state = .signedOut(message: GSAMError.signedOut.localizedDescription)
    }
}

enum SignInError: Error, Equatable, LocalizedError {
    case missingAddress
    case invalidAddress
    case insecureAddress
    case cancelled
    case expired
    case keychain

    var errorDescription: String? {
        switch self {
        case .missingAddress:
            "Enter the GSAM server address."
        case .invalidAddress:
            "That is not a server address. Use the full address, for example https://gsam.example.ts.net:3100."
        case .insecureAddress:
            "Use the https address of the GSAM server."
        case .cancelled:
            "Sign-in was cancelled. Try again."
        case .expired:
            "Sign-in timed out. Try again."
        case .keychain:
            "The phone could not save your sign-in. Try again."
        }
    }
}
