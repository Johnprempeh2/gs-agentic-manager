import Foundation

/// Sends one HTTP request. `URLSession` is the real one; tests pass a fake.
protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await data(for: request)
    }
}

enum GSAMError: Error, Equatable, LocalizedError {
    /// No answer from the server: wrong address, no network or Tailscale is off.
    case cannotReach
    /// The token is missing, expired or revoked.
    case signedOut
    /// Signed in, but this login may not see that company or item.
    case forbidden
    case server(status: Int, message: String?)
    case unreadableResponse

    var errorDescription: String? {
        switch self {
        case .cannotReach:
            "Cannot reach GSAM. Check the server address and that Tailscale is on."
        case .signedOut:
            "Your GSAM sign-in has ended. Sign in again."
        case .forbidden:
            "Your GSAM login cannot see this."
        case let .server(status, message):
            message.map { "GSAM said: \($0)" } ?? "GSAM answered with an error (\(status)). Try again."
        case .unreadableResponse:
            "GSAM sent an answer the app cannot read. Update the app or the server."
        }
    }
}

/// Talks to the GSAM API. Holds no state except the address and the token.
struct GSAMClient: Sendable {
    let baseURL: URL
    let token: String?
    let transport: HTTPTransport

    init(baseURL: URL, token: String? = nil, transport: HTTPTransport = URLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
    }

    func withToken(_ token: String) -> GSAMClient {
        GSAMClient(baseURL: baseURL, token: token, transport: transport)
    }

    // MARK: Sign-in (the same challenge flow the gsam CLI uses)

    func createSignInChallenge() async throws -> CLIAuthChallenge {
        try await send("POST", "/api/cli-auth/challenges", body: [
            "command": "GSAM iPhone app",
            "clientName": "GSAM iPhone",
        ])
    }

    func signInChallengeStatus(_ challenge: CLIAuthChallenge) async throws -> CLIAuthChallengeStatus {
        try await send("GET", "/api/cli-auth/challenges/\(challenge.id)", query: ["token": challenge.token])
    }

    func cancelSignInChallenge(_ challenge: CLIAuthChallenge) async throws {
        let _: Ignored = try await send("POST", "/api/cli-auth/challenges/\(challenge.id)/cancel", body: [
            "token": challenge.token,
        ])
    }

    /// The approval page, on the server the app talks to.
    func approvalURL(for challenge: CLIAuthChallenge) -> URL? {
        URL(string: challenge.approvalPath, relativeTo: baseURL)?.absoluteURL
    }

    func account() async throws -> Account {
        try await send("GET", "/api/cli-auth/me")
    }

    func revokeCurrentToken() async throws {
        let _: Ignored = try await send("POST", "/api/cli-auth/revoke-current")
    }

    // MARK: Reads

    func companies() async throws -> [Company] {
        try await send("GET", "/api/companies", query: ["scope": "accessible"])
    }

    func attention(companyId: String) async throws -> AttentionFeed {
        try await send("GET", "/api/companies/\(companyId)/attention", query: ["sort": "decide"])
    }

    func blockedWork(companyId: String) async throws -> BlockedWorkOverview {
        try await send("GET", "/api/companies/\(companyId)/blocked-work")
    }

    // MARK: Writes

    /// Creates a task in one company, as the signed-in user. The server
    /// answers with the existing task (`deduplicated`) when an open task with
    /// the same title was made a moment ago.
    func createIssue(companyId: String, title: String) async throws -> CreatedIssue {
        try await send("POST", "/api/companies/\(companyId)/issues", body: ["title": title])
    }

    /// A link to open a GSAM page (an `href` from the API) in the browser.
    func webURL(for href: String?) -> URL? {
        guard let href else { return nil }
        return URL(string: href, relativeTo: baseURL)?.absoluteURL
    }

    // MARK: Transport

    private struct Ignored: Decodable {}

    private struct ErrorBody: Decodable {
        let error: String?
    }

    private func send<Response: Decodable>(
        _ method: String,
        _ path: String,
        query: [String: String] = [:],
        body: [String: String]? = nil
    ) async throws -> Response {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw GSAMError.cannotReach
        }
        components.path = components.path.trimmingSuffix("/") + path
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw GSAMError.cannotReach }

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        } else if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw GSAMError.cannotReach
        }
        guard let http = response as? HTTPURLResponse else { throw GSAMError.unreadableResponse }

        switch http.statusCode {
        case 200 ..< 300:
            do {
                return try Self.decoder.decode(Response.self, from: data.isEmpty ? Data("{}".utf8) : data)
            } catch {
                throw GSAMError.unreadableResponse
            }
        case 401:
            throw GSAMError.signedOut
        case 403:
            throw GSAMError.forbidden
        default:
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw GSAMError.server(status: http.statusCode, message: message)
        }
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = ISO8601.parse(text) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date: \(text)")
        }
        return decoder
    }()
}

/// GSAM sends dates as ISO 8601, usually with milliseconds.
enum ISO8601 {
    static func parse(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}

private extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}
