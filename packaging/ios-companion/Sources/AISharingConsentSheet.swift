import SwiftUI

/// The actual send is owned by `AISharingGate` and rechecks connection + generation.
/// Dismissing this view never grants permission or sends the pending text.
struct AISharingConsentSheet: View {
    let request: AISharingRequest
    let allow: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var isAdult = false
    @State private var agreesToSharing = false

    private var isTask: Bool { request.purpose == .delegation }
    /// The coding CLIs the server lists while PTY agents are on (`ptyAgentRecipients`
    /// in src/web/ai-disclosure.ts). Only then is their own sign-in worth a line.
    private var listsCodingCLIs: Bool {
        request.recipients.contains { $0.hasPrefix("Claude Code (") || $0.hasPrefix("Codex CLI (") }
    }
    /// A relay-paired Mac's host is a placeholder; its name is what the user knows.
    private var serverName: String { request.server.remoteMac?.name ?? request.server.host }

    var body: some View {
        NavigationStack {
            Form {
                Section("Who receives your data") {
                    Text(isTask
                         ? "LISA on your Mac sends this agent task to these third-party AI services to carry it out:"
                         : "LISA sends your chat context to these third-party AI services to generate responses:")
                    ForEach(request.recipients, id: \.self) { recipient in
                        Label(recipient, systemImage: "network").font(.headline)
                    }
                    Text("Via your connected LISA server: \(serverName)")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("What is sent") {
                    if isTask {
                        Text("Your task or follow-up, and what the agent reads on your Mac while working on it, such as files, command output and tool results. Adopting a session continues its existing conversation. This can include personal information.")
                        if listsCodingCLIs {
                            Text("Claude Code and Codex send under their own sign-in on your Mac, to the provider that account uses.")
                        }
                        Text("Do not include secrets in your task.")
                    } else {
                        Text("Your message, relevant conversation history, assistant memory, and tool results. This can include personal information you put in a conversation or ask Lisa to use.")
                        Text("LISA does not automatically attach account passwords or payment-card details to AI chat requests. Do not include secrets in your message.")
                    }
                }
                Section("Your choice") {
                    Text("Allow only if you want the services named above to process this information. AI can make mistakes. Cancel keeps your \(isTask ? "task" : "draft") without sending it.")
                    Text("Permission lasts for this app session and connection, and chat and agent tasks each ask separately. Withdraw it in Settings → AI data sharing to stop a request in progress and block future sends until you allow again. Data already sent cannot be recalled, and an agent already running on your Mac keeps running until you cancel it.")
                    Link("Read the privacy policy", destination: URL(string: "https://meetlisa.ai/privacy")!)
                    Toggle("I allow sharing this \(isTask ? "task" : "chat") data with the AI services named above", isOn: $agreesToSharing)
                    Toggle("I am 18 or older", isOn: $isAdult)
                }
            }
            .navigationTitle("Share data with AI?")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    Button("Allow AI sharing and send") { allow() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!isAdult || !agreesToSharing || request.recipients.isEmpty)
                    Button(isTask ? "Cancel — keep task" : "Cancel — keep draft", role: .cancel) { dismiss() }
                }
                .frame(maxWidth: .infinity).padding()
                .background(.regularMaterial)
            }
        }
    }
}

/// Presents a gate's pending consent request. Allow grants exactly what the
/// sheet showed and sends; Cancel or a swipe-down sends nothing.
private struct AISharingConsentPresenter: ViewModifier {
    @ObservedObject var gate: AISharingGate
    let app: AppState

    func body(content: Content) -> some View {
        content.sheet(item: $gate.request) { request in
            AISharingConsentSheet(request: request) { gate.allow(request, app: app) }
        }
    }
}

extension View {
    func aiSharingConsent(_ gate: AISharingGate, app: AppState) -> some View {
        modifier(AISharingConsentPresenter(gate: gate, app: app))
    }
}
