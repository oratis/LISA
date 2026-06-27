import SwiftUI

@MainActor
final class ChatModel: ObservableObject {
    @Published var transcript = ""
    @Published var sending = false
    @Published var mood = ""
    private var task: Task<Void, Never>?
    private var moodTask: Task<Void, Never>?

    /// Seed the mood from a ping, then track the `mood` SSE — reconnecting with
    /// backoff so a mid-session drop doesn't leave the portrait stale forever.
    func startMood(_ client: LisaClient) {
        moodTask?.cancel()
        moodTask = Task { @MainActor in
            var backoffSec: UInt64 = 1
            while !Task.isCancelled {
                if let p = try? await client.islandPing() { mood = p.mood }
                do {
                    for try await msg in client.eventsStream() where msg.type == "mood" {
                        backoffSec = 1
                        if let s = msg.slug { mood = s }
                    }
                } catch { /* dropped → backoff + reconnect below */ }
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: backoffSec * 1_000_000_000)
                backoffSec = min(backoffSec * 2, 30)
            }
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
                    switch msg.type {
                    case "text":
                        if let t = msg.text { transcript += t }
                    case "error":
                        // In-band error on a 200 stream — without this the turn just
                        // hung at "…Lisa: " with no message (review A2).
                        let m = msg.object["message"] as? String ?? "the turn failed"
                        transcript += "\n⚠️ \(m)"
                    default:
                        break   // tool_start/tool_end/done — ignored in the thin chat
                    }
                }
            } catch {
                transcript += "\n⚠️ \((error as? LocalizedError)?.errorDescription ?? "Couldn't reach Lisa.")"
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
                ScrollViewReader { proxy in
                    ScrollView {
                        transcriptView
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding()
                        Color.clear.frame(height: 1).id(Self.bottomID)   // scroll anchor
                    }
                    .scrollDismissesKeyboard(.interactively)
                    // Follow the streaming reply (review A12 — long replies scrolled off).
                    .onChange(of: model.transcript) { _, _ in
                        withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                    }
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
                    .frame(width: 44, height: 44)                       // ≥44pt tap target
                    .accessibilityLabel("Send message")
                    .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending)
                }
                .padding()
            }
            .background(Theme.bgDeep.ignoresSafeArea())
            .navigationTitle("Chat")
            .task(id: app.config) { model.startMood(app.client) }
            .onDisappear { model.stopMood() }
        }
    }

    private static let bottomID = "chat-bottom"

    /// Empty → dimmed placeholder; mid-stream → raw text (cheap as it grows);
    /// settled → inline markdown (bold/links/`code`, newlines preserved). Full
    /// message bubbles + code blocks are the deferred P2 redesign.
    @ViewBuilder private var transcriptView: some View {
        if model.transcript.isEmpty {
            Text("Say hi to Lisa.").foregroundStyle(Theme.secondary)
        } else if model.sending {
            Text(model.transcript).foregroundStyle(Theme.text)
        } else {
            Text(renderedTranscript).foregroundStyle(Theme.text)
        }
    }

    private var renderedTranscript: AttributedString {
        (try? AttributedString(markdown: model.transcript,
                               options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(model.transcript)
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
        let safe = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
        HStack(spacing: 10) {
            Group {
                if let url = app.client.assetURL("/assets/lisa/\(safe).png") {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img): img.resizable().scaledToFit()
                        case .empty: ProgressView()
                        default: Image(systemName: "person.crop.circle.fill").resizable().scaledToFit().foregroundStyle(.secondary)
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Lisa's mood: \(slug)")
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
        case "happy", "content", "joyful", "playful": return Theme.green
        case "curious", "intrigued", "awe", "wonder": return Theme.accent
        case "proud": return Theme.gold
        case "weary", "tired": return Theme.idle
        case "frustrated", "annoyed": return Theme.danger
        case "affectionate", "warm": return .pink
        default: return Theme.secondary
        }
    }
}
