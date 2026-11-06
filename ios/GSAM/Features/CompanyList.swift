import SwiftUI

/// Loading, empty and error states shared by the approval and blocked lists.
struct CompanyList<Item: Equatable & Identifiable & Sendable, Row: View>: View {
    let model: CompanyListModel<Item>
    let emptyTitle: String
    let emptySymbol: String
    let emptyMessage: String
    @ViewBuilder let row: (Company, Item) -> Row

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message):
                ContentUnavailableView {
                    Label("Could not load", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") {
                        Task { await model.load() }
                    }
                    .buttonStyle(.borderedProminent)
                }
            case let .loaded(sections) where sections.isEmpty:
                ContentUnavailableView(emptyTitle, systemImage: emptySymbol, description: Text(emptyMessage))
            case let .loaded(sections):
                List {
                    ForEach(sections) { section in
                        Section(section.company.name) {
                            ForEach(section.items) { item in
                                row(section.company, item)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .refreshable { await model.load() }
        .task { await model.load() }
    }
}
