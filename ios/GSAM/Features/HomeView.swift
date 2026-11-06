import SwiftUI

struct HomeView: View {
    enum Tab: String {
        case needsYou, blocked
    }

    let store: SessionStore
    let session: Session
    @State var tab: Tab = .needsYou
    @State private var needsYou: CompanyListModel<AttentionItem>
    @State private var blocked: CompanyListModel<BlockedWorkItem>

    init(store: SessionStore, session: Session, tab: Tab = .needsYou) {
        self.store = store
        self.session = session
        _tab = State(initialValue: tab)
        _needsYou = State(initialValue: .needsYou(session: session, onSessionEnded: { store.sessionEnded() }))
        _blocked = State(initialValue: .blocked(session: session, onSessionEnded: { store.sessionEnded() }))
    }

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack {
                CompanyList(
                    model: needsYou,
                    emptyTitle: "Nothing needs you",
                    emptySymbol: "checkmark.circle",
                    emptyMessage: "No approvals or decisions are waiting for you."
                ) { company, item in
                    AttentionRow(item: item, url: session.client.webURL(for: item.subject.href))
                }
                .navigationTitle("Needs you")
                .toolbar { accountMenu }
            }
            .tabItem { Label("Needs you", systemImage: "tray.full") }
            .badge(needsYou.totalCount)
            .tag(Tab.needsYou)

            NavigationStack {
                CompanyList(
                    model: blocked,
                    emptyTitle: "Nothing is blocked",
                    emptySymbol: "checkmark.seal",
                    emptyMessage: "No task is waiting on someone else."
                ) { company, item in
                    BlockedRow(item: item, url: session.client.webURL(for: issuePath(company: company, issue: item.issue)))
                }
                .navigationTitle("Blocked")
                .toolbar { accountMenu }
            }
            .tabItem { Label("Blocked", systemImage: "hand.raised") }
            .badge(blocked.totalCount)
            .tag(Tab.blocked)
        }
    }

    private func issuePath(company: Company, issue: IssueRef) -> String? {
        guard let prefix = company.issuePrefix, let identifier = issue.identifier else { return nil }
        return "/\(prefix)/issues/\(identifier)"
    }

    private var accountMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let name = session.account.user?.name ?? session.account.user?.email {
                    Text("Signed in as \(name)")
                }
                Text(session.client.baseURL.host() ?? "")
                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    Task { await store.signOut() }
                }
            } label: {
                Label("Account", systemImage: "person.crop.circle")
            }
        }
    }
}

struct AttentionRow: View {
    let item: AttentionItem
    let url: URL?

    var body: some View {
        RowLink(url: url) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    SeverityBadge(severity: item.severity)
                    if let identifier = item.subject.identifier {
                        Text(identifier)
                            .font(.caption.monospaced())
                            .foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Text(item.activityAt, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                }
                Text(item.subject.title ?? item.whyNow)
                    .font(.body)
                    .foregroundStyle(Color.primary)
                if item.subject.title != nil {
                    Text(item.whyNow)
                        .font(.subheadline)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(3)
                }
            }
            .padding(.vertical, 2)
        }
    }
}

struct BlockedRow: View {
    let item: BlockedWorkItem
    let url: URL?

    var body: some View {
        RowLink(url: url) {
            VStack(alignment: .leading, spacing: 4) {
                if let identifier = item.issue.identifier {
                    Text(identifier)
                        .font(.caption.monospaced())
                        .foregroundStyle(Color.secondary)
                }
                Text(item.issue.title)
                    .font(.body)
                    .foregroundStyle(Color.primary)
                HStack(spacing: 4) {
                    Image(systemName: ownerSymbol)
                        .accessibilityHidden(true)
                    Text(ownerText)
                    if let since = item.waitingSince {
                        Text("·").accessibilityHidden(true)
                        Text("blocked \(since, format: .relative(presentation: .named))")
                    }
                }
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
            }
            .padding(.vertical, 2)
        }
    }

    private var ownerText: String {
        switch item.owner.type {
        case .agent: "Waiting on an agent"
        case .user: "Waiting on a person"
        case .board: "Waiting on you"
        case .nobody: "No one is named to act"
        }
    }

    private var ownerSymbol: String {
        switch item.owner.type {
        case .agent: "cpu"
        case .user: "person"
        case .board: "person.crop.circle.badge.exclamationmark"
        case .nobody: "questionmark.circle"
        }
    }
}

/// A row that opens its GSAM page in Safari, or plain text when it has none.
/// A `Link` tints `.primary` and `.secondary`, so rows use `Color.primary` and `Color.secondary`.
private struct RowLink<Content: View>: View {
    let url: URL?
    @ViewBuilder let content: Content

    var body: some View {
        if let url {
            Link(destination: url) { content }
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens in GSAM")
        } else {
            content
                .accessibilityElement(children: .combine)
        }
    }
}

struct SeverityBadge: View {
    let severity: AttentionItem.Severity

    var body: some View {
        // Words and a symbol, not colour alone.
        Label(text, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .labelStyle(.titleAndIcon)
            .accessibilityLabel("\(text) priority")
    }

    private var text: String {
        switch severity {
        case .critical: "Critical"
        case .high: "High"
        case .medium: "Medium"
        case .low: "Low"
        }
    }

    private var symbol: String {
        switch severity {
        case .critical: "exclamationmark.octagon.fill"
        case .high: "exclamationmark.triangle.fill"
        case .medium: "circle.fill"
        case .low: "circle"
        }
    }

    private var color: Color {
        switch severity {
        case .critical: .red
        case .high: .orange
        case .medium: .blue
        case .low: .secondary
        }
    }
}
