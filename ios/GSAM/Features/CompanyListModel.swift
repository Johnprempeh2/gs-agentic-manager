import Foundation
import Observation

enum LoadState<Value: Equatable>: Equatable {
    case loading
    case loaded(Value)
    case failed(message: String)
}

/// One company's rows in a list.
struct CompanySection<Item: Equatable & Identifiable>: Equatable, Identifiable {
    let company: Company
    let items: [Item]

    var id: String { company.id }
}

extension CompanySection: Sendable where Item: Sendable {}

/// Loads one kind of row (approvals, blocked work) for every company John can
/// see, and keeps only the companies that have rows. Empty means nothing
/// anywhere; one failed company fails the whole list so nothing is hidden.
@MainActor
@Observable
final class CompanyListModel<Item: Equatable & Identifiable & Sendable> {
    typealias Fetch = @Sendable (GSAMClient, Company) async throws -> [Item]

    private(set) var state: LoadState<[CompanySection<Item>]> = .loading

    @ObservationIgnored let session: Session
    @ObservationIgnored private let fetch: Fetch
    @ObservationIgnored private let onSessionEnded: @MainActor () -> Void

    init(session: Session, fetch: @escaping Fetch, onSessionEnded: @escaping @MainActor () -> Void = {}) {
        self.session = session
        self.fetch = fetch
        self.onSessionEnded = onSessionEnded
    }

    var totalCount: Int {
        guard case let .loaded(sections) = state else { return 0 }
        return sections.reduce(0) { $0 + $1.items.count }
    }

    func load() async {
        if case .failed = state { state = .loading }
        let client = session.client
        let fetch = fetch
        do {
            let sections = try await withThrowingTaskGroup(of: (Int, CompanySection<Item>).self) { group in
                for (index, company) in session.companies.enumerated() {
                    group.addTask {
                        (index, CompanySection(company: company, items: try await fetch(client, company)))
                    }
                }
                var results: [(Int, CompanySection<Item>)] = []
                for try await result in group {
                    results.append(result)
                }
                return results.sorted { $0.0 < $1.0 }.map(\.1).filter { !$0.items.isEmpty }
            }
            state = .loaded(sections)
        } catch is CancellationError {
            return
        } catch GSAMError.signedOut {
            onSessionEnded()
        } catch {
            state = .failed(message: error.localizedDescription)
        }
    }
}

extension CompanyListModel where Item == AttentionItem {
    /// What needs John: the same feed as his GSAM inbox, most urgent first.
    static func needsYou(session: Session, onSessionEnded: @escaping @MainActor () -> Void = {}) -> CompanyListModel {
        CompanyListModel(session: session, fetch: { client, company in
            try await client.attention(companyId: company.id).items
        }, onSessionEnded: onSessionEnded)
    }
}

extension CompanyListModel where Item == BlockedWorkItem {
    /// Blocked work, longest waiting first.
    static func blocked(session: Session, onSessionEnded: @escaping @MainActor () -> Void = {}) -> CompanyListModel {
        CompanyListModel(session: session, fetch: { client, company in
            try await client.blockedWork(companyId: company.id).items
        }, onSessionEnded: onSessionEnded)
    }
}
