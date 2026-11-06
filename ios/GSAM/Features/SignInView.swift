import SafariServices
import SwiftUI

struct SignInView: View {
    @Bindable var store: SessionStore
    @State private var isStarting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://gsam.example.ts.net:3100", text: $store.serverAddress)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("GSAM server address")
                } header: {
                    Text("Server")
                } footer: {
                    Text("The address you use for GSAM in the browser. Turn on Tailscale first.")
                }

                if case let .signedOut(message?) = store.state {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .accessibilityLabel("Error: \(message)")
                    }
                }

                Section {
                    Button {
                        Task {
                            isStarting = true
                            await store.startSignIn()
                            isStarting = false
                        }
                    } label: {
                        HStack {
                            Text("Sign in with GSAM")
                            Spacer()
                            if isStarting, !isWaiting {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isStarting)
                } footer: {
                    Text("GSAM opens its sign-in page. Sign in with your GSAM login and tap Approve.")
                }
            }
            .navigationTitle("GSAM")
        }
        .sheet(isPresented: approvalSheetBinding) {
            if case let .waitingForApproval(url) = store.state {
                SafariView(url: url)
                    .ignoresSafeArea()
            }
        }
    }

    private var isWaiting: Bool {
        if case .waitingForApproval = store.state { return true }
        return false
    }

    /// Open while the server waits for John to approve. Closing it by hand
    /// cancels the sign-in.
    private var approvalSheetBinding: Binding<Bool> {
        Binding(
            get: { isWaiting },
            set: { isPresented in
                if !isPresented, isWaiting {
                    Task { await store.cancelSignIn() }
                }
            }
        )
    }
}

/// The GSAM approval page in Safari, inside the app.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
