import Foundation

/// What Siri says when a command cannot run. Siri speaks
/// `localizedStringResource`, so each message says what to do next.
struct SiriError: Error, Equatable, CustomLocalizedStringResourceConvertible {
    let message: String

    var localizedStringResource: LocalizedStringResource {
        "\(message)"
    }

    static let notSignedIn = SiriError(message: "Open GSAM and sign in first.")
    static let emptyTitle = SiriError(message: "The task needs a title.")
}

/// The three Siri commands, without the App Intents glue: each one calls the
/// GSAM API with the saved sign-in and returns the sentence Siri says back.
/// Reads only the companies the signed-in login can see.
struct SiriCommands: Sendable {
    let client: GSAMClient
    var now: @Sendable () -> Date = { Date() }

    /// How many approval items Siri reads out.
    static let itemsToRead = 3

    /// The sign-in the app saved: the server address from settings and the
    /// token from the Keychain.
    static func live(
        tokenStore: TokenStore = KeychainTokenStore(),
        defaults: UserDefaults = .standard,
        transport: HTTPTransport = URLSession.shared
    ) throws -> SiriCommands {
        let address = defaults.string(forKey: SessionStore.serverAddressKey) ?? ""
        guard case let .success(url) = SessionStore.serverURL(from: address),
              let token = try? tokenStore.read()
        else { throw SiriError.notSignedIn }
        return SiriCommands(client: GSAMClient(baseURL: url, token: token, transport: transport))
    }

    /// Runs a command and turns any failure into a sentence Siri can say.
    static func spoken<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as SiriError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch GSAMError.signedOut {
            throw SiriError(message: "Your GSAM sign-in has ended. Open GSAM and sign in again.")
        } catch {
            throw SiriError(message: error.localizedDescription)
        }
    }

    func companies() async throws -> [Company] {
        try await client.companies()
    }

    // MARK: "GSAM status"

    /// How many items need John, how many tasks are blocked, and the task
    /// that has waited longest.
    func status() async throws -> String {
        let client = client
        let perCompany = try await forEachCompany { company in
            async let attention = client.attention(companyId: company.id)
            async let blocked = client.blockedWork(companyId: company.id)
            return try await (attention.totalCount, blocked)
        }
        let needsYou = perCompany.reduce(0) { $0 + $1.result.0 }
        let blocked = perCompany.reduce(0) { $0 + $1.result.1.totalBlocked }
        let oldest = perCompany
            .flatMap { $0.result.1.items }
            .filter { $0.waitingSince != nil }
            .min { $0.waitingSince! < $1.waitingSince! }

        var answer = "\(Self.needsYouPhrase(needsYou)) and \(Self.blockedPhrase(blocked))."
        if let oldest, let since = oldest.waitingSince {
            let name = [oldest.issue.identifier, oldest.issue.title].compactMap { $0 }.joined(separator: ", ")
            answer += " The longest wait is \(name), blocked for \(Self.waitText(since: since, now: now()))."
        }
        return answer
    }

    // MARK: "What needs my approval"

    /// Reads the top items of the attention feed (the same list as John's
    /// GSAM inbox), most severe first.
    func needsApproval() async throws -> String {
        let client = client
        let perCompany = try await forEachCompany { company in
            try await client.attention(companyId: company.id)
        }
        let total = perCompany.reduce(0) { $0 + $1.result.totalCount }
        guard total > 0 else { return "Nothing needs your approval in GSAM." }

        let companiesWithItems = perCompany.filter { !$0.result.items.isEmpty }
        let nameCompanies = companiesWithItems.count > 1
        // A stable sort: severity first, then each company's own order.
        let items = companiesWithItems
            .flatMap { entry in entry.result.items.map { (company: entry.company, item: $0) } }
            .enumerated()
            .sorted { lhs, rhs in
                let left = Self.severityRank(lhs.element.item.severity)
                let right = Self.severityRank(rhs.element.item.severity)
                return left == right ? lhs.offset < rhs.offset : left < right
            }
            .map(\.element)
            .prefix(Self.itemsToRead)

        var answer = Self.needsYouPhrase(total) + "."
        for (index, entry) in items.enumerated() {
            let title = entry.item.subject.title ?? entry.item.subject.identifier ?? "An item"
            let place = nameCompanies ? ", in \(entry.company.name)" : ""
            answer += " \(index + 1). \(title)\(place): \(Self.sentence(entry.item.whyNow))"
        }
        let unread = total - items.count
        if unread > 0 {
            answer += " And \(unread) more in the app."
        }
        return answer
    }

    // MARK: "Add a GSAM task"

    /// Creates a real task in the company John chose.
    func addTask(title: String, company: Company) async throws -> String {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw SiriError.emptyTitle }
        let issue = try await client.createIssue(companyId: company.id, title: title)
        let name = issue.identifier ?? "The task"
        if issue.deduplicated == true {
            return "\(name) already exists: \(issue.title). I did not add it again."
        }
        return "Added \(name) in \(company.name): \(issue.title)."
    }

    // MARK: Helpers

    /// Runs `fetch` for every company John can see, in parallel, and keeps
    /// the companies' order. One failure fails the command so nothing is hidden.
    private func forEachCompany<Value: Sendable>(
        _ fetch: @escaping @Sendable (Company) async throws -> Value
    ) async throws -> [(company: Company, result: Value)] {
        let companies = try await client.companies()
        return try await withThrowingTaskGroup(of: (Int, Value).self) { group in
            for (index, company) in companies.enumerated() {
                group.addTask { (index, try await fetch(company)) }
            }
            var results: [(Int, Value)] = []
            for try await result in group {
                results.append(result)
            }
            return results.sorted { $0.0 < $1.0 }.map { (company: companies[$0.0], result: $0.1) }
        }
    }

    static func needsYouPhrase(_ count: Int) -> String {
        switch count {
        case 0: "Nothing needs you"
        case 1: "1 item needs you"
        default: "\(count) items need you"
        }
    }

    static func blockedPhrase(_ count: Int) -> String {
        switch count {
        case 0: "no tasks are blocked"
        case 1: "1 task is blocked"
        default: "\(count) tasks are blocked"
        }
    }

    static func waitText(since: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(since))
        let days = Int(seconds / 86400)
        if days >= 1 { return days == 1 ? "1 day" : "\(days) days" }
        let hours = Int(seconds / 3600)
        if hours >= 1 { return hours == 1 ? "1 hour" : "\(hours) hours" }
        return "less than an hour"
    }

    private static func severityRank(_ severity: AttentionItem.Severity) -> Int {
        switch severity {
        case .critical: 0
        case .high: 1
        case .medium: 2
        case .low: 3
        }
    }

    /// Ends the text with a full stop so Siri pauses before the next item.
    private static func sentence(_ text: String) -> String {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = text.last else { return text }
        return ".!?".contains(last) ? text : text + "."
    }
}
