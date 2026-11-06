import AppIntents
import Foundation

// The three Siri commands. Each intent runs in the background with the saved
// sign-in (it does not open the app) and hands the work to SiriCommands,
// which the tests drive with a fake server.

struct GSAMStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "GSAM status"

    func answer(using commands: SiriCommands) async throws -> String {
        try await SiriCommands.spoken { try await commands.status() }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = try await answer(using: SiriCommands.spoken { try SiriCommands.live() })
        return .result(value: reply, dialog: "\(reply)")
    }
}

struct NeedsApprovalIntent: AppIntent {
    static let title: LocalizedStringResource = "What needs my approval"

    func answer(using commands: SiriCommands) async throws -> String {
        try await SiriCommands.spoken { try await commands.needsApproval() }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = try await answer(using: SiriCommands.spoken { try SiriCommands.live() })
        return .result(value: reply, dialog: "\(reply)")
    }
}

struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add a GSAM task"

    @Parameter(title: "Title", requestValueDialog: "What is the task?")
    var taskTitle: String

    @Parameter(title: "Company", requestValueDialog: "Which company is it for?")
    var company: CompanyEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$taskTitle) to \(\.$company)")
    }

    func answer(using commands: SiriCommands) async throws -> String {
        let chosen = Company(id: company.id, name: company.name, issuePrefix: nil)
        let title = taskTitle
        return try await SiriCommands.spoken { try await commands.addTask(title: title, company: chosen) }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = try await answer(using: SiriCommands.spoken { try SiriCommands.live() })
        return .result(value: reply, dialog: "\(reply)")
    }
}

/// A company John can see, for Siri to offer when he adds a task.
struct CompanyEntity: AppEntity, Equatable {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Company"
    static let defaultQuery = CompanyQuery()

    let id: String
    let name: String

    init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    init(_ company: Company) {
        self.init(id: company.id, name: company.name)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct CompanyQuery: EntityQuery {
    func entities(for identifiers: [CompanyEntity.ID]) async throws -> [CompanyEntity] {
        try await suggestedEntities().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [CompanyEntity] {
        try await SiriCommands.spoken { try await SiriCommands.live().companies() }.map { CompanyEntity($0) }
    }
}

/// The phrases Siri listens for. Apple requires the app name in each phrase.
struct GSAMShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GSAMStatusIntent(),
            phrases: [
                "\(.applicationName) status",
                "What is my \(.applicationName) status",
            ],
            shortTitle: "GSAM status",
            systemImageName: "gauge.with.needle"
        )
        AppShortcut(
            intent: NeedsApprovalIntent(),
            phrases: [
                "What needs my approval in \(.applicationName)",
                "What needs my \(.applicationName) approval",
            ],
            shortTitle: "Needs my approval",
            systemImageName: "checkmark.seal"
        )
        AppShortcut(
            intent: AddTaskIntent(),
            phrases: [
                "Add a \(.applicationName) task",
                "Add a task in \(.applicationName)",
            ],
            shortTitle: "Add a task",
            systemImageName: "plus.circle"
        )
    }
}
