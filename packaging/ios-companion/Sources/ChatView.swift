import SwiftUI

@MainActor
final class ChatModel: ObservableObject {
    @Published var transcript = ""
    @Published var sending = false
    private var task: Task<Void, Never>?

    func send(_ text: String, client: LisaClient) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        transcript += "\n\nYou: \(trimmed)\n\nLisa: "
        sending = true
        task = Task { @MainActor in
            defer { sending = false }
            do {
                for try await msg in client.chatStream(trimmed) {
                    if msg.type == "text", let t = msg.text { transcript += t }
                }
            } catch {
                transcript += "\n[error: \((error as? LocalizedError)?.errorDescription ?? "\(error)")]"
            }
        }
    }
}

struct ChatView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var model = ChatModel()
    @State private var input = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    Text(model.transcript.isEmpty ? "Say hi to Lisa." : model.transcript)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding()
                }
                Divider()
                HStack {
                    TextField("Message…", text: $input, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        let text = input
                        input = ""
                        model.send(text, client: app.client)
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .disabled(input.isEmpty || model.sending)
                }
                .padding()
            }
            .navigationTitle("Chat")
        }
    }
}
