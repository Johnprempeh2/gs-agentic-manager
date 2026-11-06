import Foundation

// The few fields the app reads from GSAM responses. Shapes follow
// packages/shared/src/types (attention.ts, blocked-work.ts), the
// cli-auth routes in server/src/routes/access.ts and the issue create route
// in server/src/routes/issues.ts. Unknown fields are ignored.

struct CLIAuthChallenge: Decodable, Equatable, Sendable {
    let id: String
    let token: String
    let boardApiToken: String
    let approvalPath: String
    let approvalUrl: String?
    let expiresAt: Date
    let suggestedPollIntervalMs: Int?
}

struct CLIAuthChallengeStatus: Decodable, Equatable, Sendable {
    enum Status: String, Decodable, Sendable {
        case pending, approved, cancelled, expired
    }

    let status: Status
}

struct Account: Decodable, Equatable, Sendable {
    struct User: Decodable, Equatable, Sendable {
        let id: String
        let name: String?
        let email: String?
    }

    let user: User?
    let userId: String
    let companyIds: [String]
}

struct Company: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let issuePrefix: String?
}

/// A short reference to a task, an approval or another thing in GSAM.
struct Subject: Decodable, Equatable, Sendable {
    let kind: String
    let id: String
    let title: String?
    let identifier: String?
    let status: String?
    let href: String?
}

struct AttentionItem: Decodable, Equatable, Identifiable, Sendable {
    enum Severity: String, Decodable, Sendable {
        case critical, high, medium, low
    }

    let id: String
    let companyId: String
    let sourceKind: String
    let subject: Subject
    let whyNow: String
    let severity: Severity
    let activityAt: Date
    let decideBy: Date?
}

struct AttentionFeed: Decodable, Equatable, Sendable {
    let totalCount: Int
    let items: [AttentionItem]
}

/// A task in the blocked-work overview (`BlockedWorkIssueRef`).
struct IssueRef: Decodable, Equatable, Sendable {
    let id: String
    let identifier: String?
    let title: String
    let status: String
}

struct BlockedWorkOwner: Decodable, Equatable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case agent, user, board, nobody
    }

    let type: Kind
    let agentId: String?
    let userId: String?
}

struct BlockedWorkItem: Decodable, Equatable, Identifiable, Sendable {
    let issue: IssueRef
    let waitingSince: Date?
    let owner: BlockedWorkOwner

    var id: String { issue.id }
}

struct BlockedWorkOverview: Decodable, Equatable, Sendable {
    let totalBlocked: Int
    let oldestWaitingSince: Date?
    let items: [BlockedWorkItem]
    let truncated: Bool
}

/// The answer to `POST /api/companies/:id/issues`.
struct CreatedIssue: Decodable, Equatable, Sendable {
    let id: String
    let identifier: String?
    let title: String
    let deduplicated: Bool?
}
