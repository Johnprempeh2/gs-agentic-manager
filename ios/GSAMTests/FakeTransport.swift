import Foundation
@testable import GSAM

/// Answers requests from a list of routes and records what was sent.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    struct Reply {
        var status = 200
        var body = "{}"
        var error: Error?
    }

    private let lock = NSLock()
    private var routes: [(match: String, replies: [Reply])] = []
    private(set) var requests: [URLRequest] = []

    /// Replies in order for requests whose "METHOD path" contains `match`;
    /// the last reply repeats.
    func on(_ match: String, _ replies: Reply...) {
        lock.withLock { routes.append((match, replies)) }
    }

    func on(_ match: String, json: String, status: Int = 200) {
        on(match, Reply(status: status, body: json))
    }

    var sent: [URLRequest] {
        lock.withLock { requests }
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
        let reply: Reply = lock.withLock {
            requests.append(request)
            guard let index = routes.firstIndex(where: { key.contains($0.match) }) else {
                return Reply(status: 404, body: #"{"error":"No fake route for \#(key)"}"#)
            }
            let replies = routes[index].replies
            if replies.count > 1 { routes[index].replies.removeFirst() }
            return replies[0]
        }
        if let error = reply.error { throw error }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
        return (Data(reply.body.utf8), response)
    }
}

enum Fixtures {
    static let baseURL = URL(string: "https://gsam.example.ts.net:3100")!

    static let account = #"{"user":{"id":"u1","name":"John","email":"john@example.com"},"userId":"u1","companyIds":["c1","c2"],"isInstanceAdmin":true}"#

    static let companies = #"[{"id":"c1","name":"Greatstone International","issuePrefix":"GRE","status":"active"},{"id":"c2","name":"Second Co","issuePrefix":"SEC"}]"#

    static let challenge = """
    {"id":"9f1c2a7e-0000-4000-8000-000000000001","token":"challenge-secret-0123456789","boardApiToken":"board-token-from-challenge",
     "approvalPath":"/cli-auth/9f1c2a7e-0000-4000-8000-000000000001?token=challenge-secret-0123456789",
     "approvalUrl":"http://127.0.0.1:3100/cli-auth/9f1c2a7e?token=x","pollPath":"/cli-auth/challenges/9f1c2a7e-0000-4000-8000-000000000001",
     "expiresAt":"2099-01-01T00:00:00.000Z","suggestedPollIntervalMs":1000}
    """

    static let expiredChallenge = challenge.replacingOccurrences(of: "2099-01-01", with: "2000-01-01")

    static let attention = """
    {"companyId":"c1","generatedAt":"2026-11-06T09:00:00.000Z","totalCount":1,"deskBadgeCount":1,"nextCursor":null,
     "countsBySourceKind":{},"items":[
      {"id":"a1","companyId":"c1","sourceKind":"approval","severity":"high","activityAt":"2026-11-06T08:30:00.000Z",
       "decideBy":null,"whyNow":"Everest asks you to approve the release.","decisionVerbs":[],"rank":1,
       "subject":{"kind":"approval","id":"ap1","companyId":"c1","title":"Release to live","identifier":null,"status":"pending","href":"/GRE/approvals/ap1"}}
     ]}
    """

    static let emptyAttention = #"{"companyId":"c2","totalCount":0,"items":[]}"#

    static let blocked = """
    {"generatedAt":"2026-11-06T09:00:00.000Z","totalBlocked":1,"oldestWaitingSince":"2026-11-03T09:00:00Z","rootCauses":[],"truncated":false,
     "items":[{"issue":{"id":"i1","identifier":"GRE-4196","title":"Buy the Apple Developer account","status":"blocked"},
       "waitingSince":"2026-11-03T09:00:00Z","owner":{"type":"board","agentId":null,"userId":null},"rootIssueIds":["i1"],"tidyReason":null}]}
    """

    static let emptyBlocked = #"{"totalBlocked":0,"oldestWaitingSince":null,"items":[],"truncated":false,"rootCauses":[]}"#
}
