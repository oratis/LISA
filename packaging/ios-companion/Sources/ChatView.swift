import SwiftUI

@MainActor
final class ChatModel: ObservableObject {
    @Published var transcript = ""
    @Published var sending = false
    @Published var mood = ""
    private var task: Task<Void, Never>?
    private var moodTask: Task<Void, Never>?

    /// Seed the mood from a ping, then track the `mood` SSE for live changes.
    func startMood(_ client: LisaClient) {
        moodTask?.cancel()
        moodTask = Task { @MainActor in
            if let p = try? await client.islandPing() { mood = p.mood }
            do {
                for try await msg in client.eventsStream() where msg.type == "mood" {
                    if let s = msg.slug { mood = s }
                }
            } catch { /* stream dropped — reseeded on next appear */ }
        }
    }
    func stopMood() { moodTask?.cancel(); moodTask = nil }

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
                if !model.mood.isEmpty {
                    MoodPortrait(mood: model.mood)
                        .padding(.horizontal).padding(.vertical, 6)
                    Divider()
                }
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
            .task(id: app.config) { model.startMood(app.client) }
            .onDisappear { model.stopMood() }
        }
    }
}

/// Lisa's current mood as a real portrait + label. The portrait is the server's
/// own art (`/assets/lisa/<slug>.png`, the same set the web island uses), loaded
/// over the existing connection — no bundling, always in sync. Falls back to the
/// mood chip while loading or if the slug has no art.
struct MoodPortrait: View {
    @EnvironmentObject var app: AppState
    let mood: String

    var body: some View {
        let slug = mood.isEmpty ? "neutral" : mood
        HStack(spacing: 10) {
            Group {
                if let url = app.client.assetURL("/assets/lisa/\(slug).png") {
                    AsyncImage(url: url) { phase in
                        if case .success(let img) = phase {
                            img.resizable().scaledToFit()
                        } else {
                            Image(systemName: "person.crop.circle.fill").resizable().scaledToFit().foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Image(systemName: "person.crop.circle.fill").resizable().scaledToFit().foregroundStyle(.secondary)
                }
            }
            .frame(width: 48, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            MoodChip(mood: slug)
            Spacer()
        }
    }
}

/// Lisa's current mood as a small labeled chip — the caption beside the portrait,
/// and the fallback while/if the portrait can't load.
struct MoodChip: View {
    let mood: String
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).foregroundStyle(color)
            Text(mood.capitalized).font(.subheadline.weight(.medium))
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(color.opacity(0.12), in: Capsule())
    }

    private var symbol: String {
        switch mood.lowercased() {
        case "happy", "content", "joyful", "playful": return "face.smiling"
        case "curious", "intrigued": return "sparkle.magnifyingglass"
        case "proud": return "star.fill"
        case "weary", "tired": return "moon.zzz"
        case "frustrated", "annoyed": return "exclamationmark.bubble"
        case "affectionate", "warm": return "heart.fill"
        case "awe", "wonder": return "sparkles"
        default: return "circle.fill"
        }
    }
    private var color: Color {
        switch mood.lowercased() {
        case "happy", "content", "joyful", "playful": return .green
        case "curious", "intrigued", "awe", "wonder": return .blue
        case "proud": return .yellow
        case "weary", "tired": return .gray
        case "frustrated", "annoyed": return .red
        case "affectionate", "warm": return .pink
        default: return .secondary
        }
    }
}
