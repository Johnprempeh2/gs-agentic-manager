#if DEBUG
import Foundation

/// Sample data for simulator screenshots, with no server. Debug builds only.
/// Launch with `-GSAMDemo <screen>`: signIn, needsYou, blocked, empty or error.
struct DemoMode {
    enum Screen: String {
        case signIn, needsYou, blocked, empty, error
    }

    let screen: Screen

    static func fromLaunchArguments(_ arguments: [String] = ProcessInfo.processInfo.arguments) -> DemoMode? {
        guard let index = arguments.firstIndex(of: "-GSAMDemo"), arguments.indices.contains(index + 1),
              let screen = Screen(rawValue: arguments[index + 1])
        else { return nil }
        return DemoMode(screen: screen)
    }

    var tab: HomeView.Tab { screen == .blocked ? .blocked : .needsYou }

    @MainActor
    func makeStore() -> SessionStore {
        let defaults = UserDefaults(suiteName: "gsam.demo") ?? .standard
        defaults.set("https://gsam.example.ts.net:3100", forKey: SessionStore.serverAddressKey)
        return SessionStore(
            tokenStore: InMemoryTokenStore(token: screen == .signIn ? nil : "demo"),
            transport: DemoTransport(screen: screen),
            defaults: defaults
        )
    }
}

private struct DemoTransport: HTTPTransport {
    let screen: DemoMode.Screen

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let path = request.url?.path() ?? ""
        let body: String
        if path.hasSuffix("/cli-auth/me") {
            body = #"{"user":{"id":"u1","name":"John","email":"john@example.com"},"userId":"u1","companyIds":["c1"]}"#
        } else if path.hasSuffix("/api/companies") {
            body = #"[{"id":"c1","name":"Greatstone International","issuePrefix":"GRE"}]"#
        } else if screen == .error {
            throw URLError(.cannotConnectToHost)
        } else if path.hasSuffix("/attention") {
            body = screen == .empty ? #"{"totalCount":0,"items":[]}"# : Self.attention
        } else if path.hasSuffix("/blocked-work") {
            body = screen == .empty
                ? #"{"totalBlocked":0,"oldestWaitingSince":null,"items":[],"truncated":false}"#
                : Self.blocked
        } else {
            body = "{}"
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), response)
    }

    private static func ago(_ seconds: TimeInterval) -> String {
        Date().addingTimeInterval(-seconds).formatted(.iso8601)
    }

    private static var attention: String {
        """
        {"totalCount":3,"items":[
          {"id":"a1","companyId":"c1","sourceKind":"approval","severity":"high","activityAt":"\(ago(1_800))",
           "whyNow":"Everest asks you to approve the November release.",
           "subject":{"kind":"approval","id":"ap1","title":"Release v2026.11.6 to live","identifier":null,"status":"pending","href":"/GRE/approvals/ap1"}},
          {"id":"a2","companyId":"c1","sourceKind":"issue_thread_interaction","severity":"medium","activityAt":"\(ago(7_200))",
           "whyNow":"Mica asks which header design to ship.",
           "subject":{"kind":"interaction","id":"i1","title":"Pick the new board header","identifier":"GRE-4101","status":"pending","href":"/GRE/issues/GRE-4101"}},
          {"id":"a3","companyId":"c1","sourceKind":"decision","severity":"low","activityAt":"\(ago(90_000))",
           "whyNow":"Summit wants a yes or no on the weekly cost report.",
           "subject":{"kind":"decision","id":"d1","title":"Send the cost report every Monday","identifier":"GRE-4077","status":"open","href":"/GRE/issues/GRE-4077"}}
        ]}
        """
    }

    private static var blocked: String {
        """
        {"totalBlocked":3,"oldestWaitingSince":"\(ago(259_200))","truncated":false,"items":[
          {"issue":{"kind":"issue","id":"b1","identifier":"GRE-4196","title":"Buy the Apple Developer account","status":"blocked"},
           "waitingSince":"\(ago(259_200))","owner":{"type":"board","agentId":null,"userId":null}},
          {"issue":{"kind":"issue","id":"b2","identifier":"GRE-4150","title":"Move the backups to the new disk","status":"blocked"},
           "waitingSince":"\(ago(86_400))","owner":{"type":"agent","agentId":"ag1","userId":null}},
          {"issue":{"kind":"issue","id":"b3","identifier":"GRE-4122","title":"Check the Pipedrive export","status":"blocked"},
           "waitingSince":"\(ago(14_400))","owner":{"type":"nobody","agentId":null,"userId":null}}
        ]}
        """
    }
}
#endif
