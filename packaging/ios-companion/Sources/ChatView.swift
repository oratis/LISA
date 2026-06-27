import SwiftUI

/// One chat turn. Lisa's text accumulates during streaming; `tools` collects the
/// tool names she invokes (rendered as chips); `isError` flags a failed turn.
struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, lisa }
    let id = UUID()
    var role: Role
    var text: String = ""
    var tools: [String] = []
    var isError: Bool = false
}

@MainActor
final class ChatModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var sending = false
    @Published var mood = ""
    @Published var loadingHistory = false
    @Published private(set) var hasMore = false
    private var page = 0
    private var task: Task<Void, Never>?
    private var moodTask: Task<Void, Never>?

    // ── history ──
    func loadHistory(_ client: LisaClient) async {
        guard messages.isEmpty, let r = try? await client.history(page: 0) else { return }
        messages = r.messages.map(Self.map)
        page = 0
        hasMore = r.hasMore
    }

    func loadEarlier(_ client: LisaClient) async {
        guard hasMore, !loadingHistory else { return }
        loadingHistory = true
        defer { loadingHistory = false }
        guard let r = try? await client.history(page: page + 1) else { return }
        messages.insert(contentsOf: r.messages.map(Self.map), at: 0)
        page += 1
        hasMore = r.hasMore
    }

    private static func map(_ m: HistoryMessage) -> ChatMessage {
        ChatMessage(role: m.role == "user" ? .user : .lisa, text: m.content)
    }

    // ── mood (seed from a ping, then track the SSE, reconnect with backoff) ──
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

    // ── send ──
    func send(_ text: String, client: LisaClient) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        messages.append(ChatMessage(role: .user, text: trimmed))
        messages.append(ChatMessage(role: .lisa))
        let idx = messages.count - 1
        sending = true
        task = Task { @MainActor in
            defer { sending = false }
            do {
                for try await msg in client.chatStream(trimmed) {
                    switch msg.type {
                    case "text":
                        if let t = msg.text { messages[idx].text += t }
                    case "tool_start":
                        if let n = msg.object["name"] as? String, !messages[idx].tools.contains(n) {
                            messages[idx].tools.append(n)
                        }
                    case "error":
                        messages[idx].isError = true
                        let m = msg.object["message"] as? String ?? "the turn failed"
                        messages[idx].text += (messages[idx].text.isEmpty ? "" : "\n") + m
                    default:
                        break
                    }
                }
                if messages[idx].text.isEmpty && messages[idx].tools.isEmpty && !messages[idx].isError {
                    messages[idx].text = "(no response)"
                }
            } catch {
                messages[idx].isError = true
                messages[idx].text = (error as? LocalizedError)?.errorDescription ?? "Couldn't reach Lisa."
            }
        }
    }
}

struct ChatView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var model = ChatModel()
    @State private var input = ""
    private static let bottomID = "chat-bottom"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !model.mood.isEmpty {
                    MoodPortrait(mood: model.mood)
                        .padding(.horizontal).padding(.vertical, Theme.Space.s)
                    Divider()
                }
                transcript
                Divider()
                composer
            }
            .background(Theme.bgDeep.ignoresSafeArea())
            .navigationTitle("Chat")
            .task(id: app.config) { model.startMood(app.client); await model.loadHistory(app.client) }
            .onDisappear { model.stopMood() }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if model.hasMore {
                    Button { Task { await model.loadEarlier(app.client) } } label: {
                        if model.loadingHistory { ProgressView() }
                        else { Text("Load earlier").font(.caption) }
                    }
                    .padding(.top, Theme.Space.s)
                }
                LazyVStack(spacing: Theme.Space.m) {
                    if model.messages.isEmpty {
                        Text("Say hi to Lisa.")
                            .foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    }
                    ForEach(model.messages) { MessageBubble(message: $0) }
                    if model.sending {
                        TypingIndicator().frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
                Color.clear.frame(height: 1).id(Self.bottomID)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages) { _, _ in scrollToBottom(proxy) }
            .onChange(of: model.sending) { _, _ in scrollToBottom(proxy) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
    }

    private var composer: some View {
        HStack(spacing: Theme.Space.s) {
            TextField("Message…", text: $input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
            Button {
                let text = input
                input = ""
                model.send(text, client: app.client)
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .frame(width: 44, height: 44)
            .accessibilityLabel("Send message")
            .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending)
        }
        .padding()
    }
}

/// A user/Lisa chat bubble: markdown text segments + fenced code as CodeBlocks +
/// tool chips for the tools Lisa ran this turn.
struct MessageBubble: View {
    let message: ChatMessage
    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 36) }
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                    switch seg {
                    case .text(let t):
                        Text(renderMarkdown(t)).textSelection(.enabled)
                    case .code(let c):
                        CodeBlock(text: c)
                    }
                }
                if !message.tools.isEmpty {
                    HStack(spacing: Theme.Space.xs) {
                        ForEach(message.tools, id: \.self) { tool in
                            ThemePill(text: tool, color: Theme.accent)
                        }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(bubbleBg, in: RoundedRectangle(cornerRadius: 14))
            .foregroundStyle(message.isError ? Theme.danger : Theme.text)
            .frame(maxWidth: 320, alignment: message.role == .user ? .trailing : .leading)
            if message.role == .lisa { Spacer(minLength: 36) }
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.role == .user ? "You" : "Lisa"): \(message.text)")
    }

    private var segments: [MessageSegment] { parseSegments(message.text) }
    private var bubbleBg: Color { message.role == .user ? Theme.accent.opacity(0.18) : Theme.card }
}

/// Animated "Lisa is typing" dots shown while a turn streams.
struct TypingIndicator: View {
    @State private var animate = false
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { i in
                Circle().fill(Theme.secondary).frame(width: 7, height: 7)
                    .scaleEffect(animate ? 1 : 0.5)
                    .animation(.easeInOut(duration: 0.5).repeatForever().delay(Double(i) * 0.15), value: animate)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .onAppear { animate = true }
        .accessibilityLabel("Lisa is typing")
    }
}

// ── markdown + fenced-code segmentation ──

enum MessageSegment { case text(String); case code(String) }

/// Split a message into prose vs ``` fenced code blocks, so code renders in a
/// proper monospaced CodeBlock instead of as illegible inline text.
func parseSegments(_ s: String) -> [MessageSegment] {
    guard s.contains("```") else { return [.text(s)] }
    var segs: [MessageSegment] = []
    var inCode = false
    var buf: [String] = []
    func flush() {
        let joined = buf.joined(separator: "\n")
        if inCode { segs.append(.code(joined)) }
        else if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { segs.append(.text(joined)) }
        buf = []
    }
    for line in s.components(separatedBy: "\n") {
        if line.hasPrefix("```") { flush(); inCode.toggle() }
        else { buf.append(line) }
    }
    flush()
    return segs.isEmpty ? [.text(s)] : segs
}

/// Inline markdown (bold/italic/links/`code`) preserving newlines.
func renderMarkdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s,
                           options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
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
