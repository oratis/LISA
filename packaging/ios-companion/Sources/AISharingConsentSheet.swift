import SwiftUI

/// The actual send is owned by ChatView and rechecks connection + generation.
/// Dismissing this view never grants permission or sends the pending draft.
struct AISharingConsentSheet: View {
    let request: AISharingRequest
    let allow: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var isAdult = false
    @State private var agreesToSharing = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Who receives your data") {
                    Text("LISA sends your chat context to these third-party AI services to generate responses:")
                    ForEach(request.recipients, id: \.self) { recipient in
                        Label(recipient, systemImage: "network").font(.headline)
                    }
                    Text("Via your connected LISA server: \(request.server.host)")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("What is sent") {
                    Text("Your message, relevant conversation history, assistant memory, and tool results. This can include personal information you put in a conversation or ask Lisa to use.")
                    Text("LISA does not automatically attach account passwords or payment-card details to AI chat requests. Do not include secrets in your message.")
                }
                Section("Your choice") {
                    Text("Allow only if you want the services named above to process this information. AI can make mistakes. Cancel keeps your draft without sending it.")
                    Text("Permission lasts for this app session and connection. Withdraw it in Settings → AI data sharing to stop an active chat and block future sends until you allow again. Data already sent cannot be recalled.")
                    Link("Read the privacy policy", destination: URL(string: "https://meetlisa.ai/privacy")!)
                    Toggle("I allow sharing this chat data with the AI services named above", isOn: $agreesToSharing)
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
                    Button("Cancel — keep draft", role: .cancel) { dismiss() }
                }
                .frame(maxWidth: .infinity).padding()
                .background(.regularMaterial)
            }
        }
    }
}
