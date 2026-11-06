import SwiftUI

@main
struct GSAMApp: App {
    @State private var store: SessionStore
    private let startTab: HomeView.Tab

    init() {
        #if DEBUG
        if let demo = DemoMode.fromLaunchArguments() {
            _store = State(initialValue: demo.makeStore())
            startTab = demo.tab
            return
        }
        #endif
        _store = State(initialValue: SessionStore())
        startTab = .needsYou
    }

    var body: some Scene {
        WindowGroup {
            RootView(store: store, startTab: startTab)
        }
    }
}

struct RootView: View {
    let store: SessionStore
    let startTab: HomeView.Tab

    var body: some View {
        Group {
            switch store.state {
            case .restoring:
                ProgressView("Signing in")
            case .signedOut, .waitingForApproval:
                SignInView(store: store)
            case let .signedIn(session):
                HomeView(store: store, session: session, tab: startTab)
                    .id(session.account.userId)
            case let .unreachable(message):
                ContentUnavailableView {
                    Label("Cannot reach GSAM", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await store.restore() } }
                        .buttonStyle(.borderedProminent)
                    Button("Sign out", role: .destructive) { Task { await store.signOut() } }
                }
            }
        }
        .task { await store.restore() }
    }
}
