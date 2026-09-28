import SwiftUI

/// One chat turn. Lisa's text accumulates during streaming; `tools` collects the
/// tool names she invokes (rendered as chips); `status` tracks how the turn ended
/// so the UI can offer a retry instead of a dead end.
struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, lisa }
    /// Lifecycle of a Lisa turn. `streaming` while tokens arrive; then one of the
    /// terminal states. `empty`/`cancelled` are retryable but not failures.
    enum Status: Equatable { case streaming, ok, empty, error, cancelled }
    let id = UUID()
    var role: Role
    var text: String = ""
    var tools: [String] = []
    var status: Status = .ok
    /// The turn died because the session allowance is spent (HTTP 402). Drives
    /// the inline "Add credits…" button — a second route to the In-App
    /// Purchases that doesn't depend on the Settings quota card rendering.
    var needsCredits: Bool = false
    var isError: Bool { status == .error }
    /// Terminal states the user can retry from (nothing useful landed).
    var isRetryable: Bool { status == .error || status == .empty || status == .cancelled }
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
    /// The last thing the user said — replayed by `resend()` when a turn comes
    /// back empty / errored / cancelled.
    private var lastUserText: String?

    // ── history ──
    func loadHistory(_ client: LisaClient) async {
        guard messages.isEmpty, let r = try? await client.history(page: 0) else { return }
        messages = r.messages.compactMap(Self.map)
        page = 0
        hasMore = r.hasMore
    }

    func loadEarlier(_ client: LisaClient) async {
        guard hasMore, !loadingHistory else { return }
        loadingHistory = true
        defer { loadingHistory = false }
        guard let r = try? await client.history(page: page + 1) else { return }
        messages.insert(contentsOf: r.messages.compactMap(Self.map), at: 0)
        page += 1
        hasMore = r.hasMore
    }

    private static func map(_ m: HistoryMessage) -> ChatMessage? {
        // Tool-result-only records are model context, not a user chat bubble.
        guard !m.content.isEmpty || !m.tools.isEmpty else { return nil }
        return ChatMessage(role: m.role == "user" ? .user : .lisa, text: m.content, tools: m.tools)
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

    // ── send / retry / stop ──
    func send(_ text: String, client: LisaClient) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sending else { return }
        messages.append(ChatMessage(role: .user, text: trimmed))
        lastUserText = trimmed
        runTurn(trimmed, client: client)
    }

    /// Replay the last user message. Drops a trailing failed/empty Lisa bubble so
    /// the retry visually replaces it rather than stacking a second dead end.
    func resend(client: LisaClient) {
        guard let text = lastUserText, !sending else { return }
        if let last = messages.last, last.role == .lisa, last.isRetryable {
            messages.removeLast()
        }
        runTurn(text, client: client)
    }

    /// Stop the in-flight turn. Cancelling the task tears down the SSE stream,
    /// which also closes the connection so the Mac can abort the agent.
    func cancel() { task?.cancel() }

    private func runTurn(_ userText: String, client: LisaClient) {
        messages.append(ChatMessage(role: .lisa, status: .streaming))
        let idx = messages.count - 1
        sending = true
        task = Task { @MainActor in
            defer { sending = false }
            do {
                for try await msg in client.chatStream(userText) {
                    guard messages.indices.contains(idx) else { break }
                    switch msg.type {
                    case "text":
                        if let t = msg.text, !t.isEmpty { messages[idx].text += t }
                    case "tool_start":
                        if let n = msg.object["name"] as? String, !messages[idx].tools.contains(n) {
                            messages[idx].tools.append(n)
                        }
                    case "error":
                        messages[idx].status = .error
                        let m = msg.object["message"] as? String ?? "the turn failed"
                        messages[idx].text += (messages[idx].text.isEmpty ? "" : "\n") + m
                    case "empty":
                        // Server signals the turn produced nothing (e.g. a provider
                        // hiccup). Resolved to `.empty` in resolveEnding below.
                        break
                    default:
                        break
                    }
                }
                resolveEnding(idx)
            } catch {
                markFailed(idx, error)
            }
        }
    }

    /// A cleanly-finished stream: decide the terminal status. Text/tools ⇒ ok;
    /// otherwise it's an empty turn (retryable, not an error).
    private func resolveEnding(_ idx: Int) {
        guard messages.indices.contains(idx), messages[idx].status == .streaming else { return }
        if messages[idx].text.isEmpty && messages[idx].tools.isEmpty {
            messages[idx].status = .empty
            messages[idx].text = "Lisa didn't reply."
        } else {
            messages[idx].status = .ok
        }
    }

    /// The gateway refuses an unaffordable turn with a clean 402 before it
    /// streams anything — that's "out of allowance", not a failure to reach us.
    static func isQuotaExhausted(_ error: Error) -> Bool {
        if case LisaError.http(402) = error { return true }
        return false
    }

    /// A thrown stream: a user-initiated stop reads as `.cancelled`; anything else
    /// is a real error. Either way it's retryable.
    private func markFailed(_ idx: Int, _ error: Error) {
        guard messages.indices.contains(idx) else { return }
        let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
        if cancelled {
            messages[idx].status = .cancelled
            if messages[idx].text.isEmpty { messages[idx].text = "Stopped." }
        } else if Self.isQuotaExhausted(error) {
            // Quota exhausted (B4): the server refused the turn with a clean 402
            // before streaming. Same copy as the web paywall (strings.ts), minus
            // the "go to Settings" pointer — the button below opens the packs.
            messages[idx].status = .error
            messages[idx].needsCredits = true
            messages[idx].text = "Your free allowance for this session is used up — it refreshes every 12 hours. Add credits to keep going now."
        } else {
            messages[idx].status = .error
            let msg = (error as? LocalizedError)?.errorDescription ?? "Couldn't reach Lisa."
            messages[idx].text += (messages[idx].text.isEmpty ? "" : "\n") + msg
        }
    }
}

struct ChatView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var model = ChatModel()
    @State private var input = ""
    @State private var showPaywall = false
    @State private var consentRecipients: [String] = []
    @State private var consentServer: ServerConfig?
    @State private var consentGeneration: UUID?
    @State private var isAdult = false
    @State private var pendingText = ""
    @State private var showAIConsent = false
    @State private var checkingConsent = false
    @State private var loadedConfig: ServerConfig?
    private static let bottomID = "chat-bottom"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                transcript
                Divider()
                quickChips
                composer
            }
            .background(Theme.bgDeep.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { chatHeader }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.loadEarlier(app.client) } } label: {
                        Image(systemName: "clock.arrow.circlepath")
                    }
                    .disabled(!model.hasMore || model.loadingHistory)
                    .accessibilityLabel("Load earlier messages")
                }
            }
            .task(id: app.config) {
                loadedConfig = app.config
                model.startMood(app.client)
                await model.loadHistory(app.client)
            }
            .onDisappear {
                model.stopMood()
                if loadedConfig != app.config { model.cancel() }
            }
            .onAppear { consumeDraft() }
            .onChange(of: app.chatDraft) { _, _ in consumeDraft() }
            .onChange(of: app.aiConsent.generation) { _, _ in
                showAIConsent = false
                pendingText = ""
                isAdult = false
                model.cancel()
            }
            .sheet(isPresented: $showPaywall) { PaywallSheet().environmentObject(app) }
            .sheet(isPresented: $showAIConsent) {
                NavigationStack {
                    List {
                        Section("Who receives your data") {
                            Text("Your message, relevant conversation history, assistant memory and tool results are processed by your connected LISA server and these configured AI services:")
                            ForEach(consentRecipients, id: \.self) { Text($0) }
                        }
                        Section("Your choice") {
                            Text("This is needed to generate AI responses. AI can make mistakes. Only send information you want these services to process. Cancel keeps your draft. You can withdraw permission in Settings → AI data sharing at any time.")
                            Link("Privacy policy", destination: URL(string: "https://meetlisa.ai/privacy")!)
                            Toggle("I am 18 or older", isOn: $isAdult)
                            Button("Allow and send this message") {
                                guard let server = consentServer, server == app.config,
                                      let generation = consentGeneration,
                                      app.aiConsent.grant(server: server, recipients: consentRecipients,
                                                          isAdult: isAdult, generation: generation) else { return }
                                showAIConsent = false
                                deliver(pendingText)
                            }.buttonStyle(.borderedProminent).disabled(!isAdult)
                            Button("Cancel", role: .cancel) { showAIConsent = false }
                        }
                    }.navigationTitle("AI data sharing")
                }
            }
        }
    }

    private func consumeDraft() {
        guard !app.chatDraft.isEmpty else { return }
        input = app.chatDraft
        app.chatDraft = ""
    }

    /// Compact inline header: small mood portrait + "Lisa · <mood>" (redesign —
    /// replaces the big nav title + portrait row).
    private var chatHeader: some View {
        HStack(spacing: 8) {
            moodAvatar(28)
            VStack(alignment: .leading, spacing: 0) {
                Text("Lisa").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                if !model.mood.isEmpty {
                    Text(model.mood.replacingOccurrences(of: "-", with: " "))
                        .font(.caption2).foregroundStyle(Theme.green)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Lisa\(model.mood.isEmpty ? "" : ", \(model.mood)")")
    }

    private func moodAvatar(_ size: CGFloat) -> some View {
        let slug = model.mood.isEmpty ? "neutral" : model.mood
        let safe = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
        return ServerPortrait(client: app.client, path: "/assets/lisa/\(safe).png")
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityHidden(true)   // chatHeader's combined label already says the mood
    }

    private let quickCommands = ["Help me plan my day", "Help me write a draft", "Break down a goal"]

    /// Tappable quick-command chips above the composer — there's always a next move.
    @ViewBuilder private var quickChips: some View {
        if !model.sending {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Space.s) {
                    ForEach(quickCommands, id: \.self) { cmd in
                        Button { input = cmd } label: {
                            Text(cmd).font(.caption)
                                .padding(.horizontal, 12).padding(.vertical, 7)
                                .background(Theme.accent.opacity(0.14), in: Capsule())
                                .foregroundStyle(Theme.accent)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Adds an editable draft. Tap Send when ready.")
                    }
                }
                .padding(.horizontal).padding(.vertical, Theme.Space.s)
            }
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
                        emptyState.padding(.top, 60)
                    }
                    ForEach(model.messages) { msg in
                        // A blank streaming bubble is stood in for by the typing
                        // indicator below — don't render an empty bubble.
                        if !isWaitingBubble(msg) {
                            MessageBubble(
                                message: msg,
                                onRetry: retryAction(for: msg),
                                onAddCredits: msg.needsCredits ? { showPaywall = true } : nil
                            )
                        }
                    }
                    if showTyping {
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

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.largeTitle).foregroundStyle(Theme.tertiary)
            Text("Ask Lisa anything — or tap a suggestion below.")
                .font(.callout).foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    /// A Lisa turn that's mid-stream with nothing to show yet.
    private func isWaitingBubble(_ msg: ChatMessage) -> Bool {
        msg.role == .lisa && msg.status == .streaming && msg.text.isEmpty && msg.tools.isEmpty
    }

    /// Show the typing indicator while the newest Lisa turn hasn't produced anything.
    private var showTyping: Bool {
        guard model.sending, let last = model.messages.last else { return false }
        return isWaitingBubble(last)
    }

    /// Offer Retry only on the newest turn, when it ended with nothing useful.
    private func retryAction(for msg: ChatMessage) -> (() -> Void)? {
        guard !model.sending, msg.role == .lisa, msg.isRetryable,
              msg.id == model.messages.last?.id else { return nil }
        return { requestSend(model.messages.last(where: { $0.role == .user })?.text ?? "") }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
    }

    private var composer: some View {
        HStack(spacing: Theme.Space.s) {
            TextField("Message…", text: $input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .onSubmit(sendCurrent)
            if model.sending {
                Button { model.cancel() } label: {
                    Image(systemName: "stop.circle.fill").font(.title2)
                }
                .frame(width: 44, height: 44)
                .foregroundStyle(Theme.danger)
                .accessibilityLabel("Stop")
                .accessibilityHint("Stops Lisa's reply")
            } else {
                Button(action: sendCurrent) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .frame(width: 44, height: 44)
                .accessibilityLabel("Send message")
                .accessibilityHint("Sends what you typed to Lisa")
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || checkingConsent || !app.config.isConfigured)
            }
        }
        .padding()
    }

    private func sendCurrent() {
        requestSend(input)
    }

    private func requestSend(_ text: String) {
        guard !checkingConsent, !model.sending, !text.trimmed.isEmpty else { return }
        checkingConsent = true
        let expected = app.config
        let generation = app.aiConsent.generation
        Task { @MainActor in
            defer { checkingConsent = false }
            let disclosure = try? await LisaClient.authConfig(base: expected).dataProcessing
            guard app.config == expected, app.aiConsent.generation == generation else { return }
            guard let disclosure, disclosure.version == 1, !disclosure.recipients.isEmpty else {
                app.notify("Couldn't load AI provider information. Retry, or update your LISA server before sending.", ok: false)
                return
            }
            consentRecipients = disclosure.recipients
            if app.aiConsent.allows(server: expected, recipients: consentRecipients) { deliver(text) }
            else {
                consentServer = expected
                consentGeneration = generation
                isAdult = false
                pendingText = text
                showAIConsent = true
            }
        }
    }

    private func deliver(_ text: String) {
        guard app.aiConsent.allows(server: app.config, recipients: consentRecipients) else { return }
        input = ""
        model.send(text, client: app.client)
    }
}

/// A user/Lisa chat bubble: markdown text segments + fenced code as CodeBlocks +
/// tool chips for the tools Lisa ran this turn. An optional Retry appears when the
/// turn came back empty / errored / stopped.
struct MessageBubble: View {
    let message: ChatMessage
    var onRetry: (() -> Void)? = nil
    /// Present when the turn was refused for lack of credits — the in-chat
    /// route to the In-App Purchases (see `ChatMessage.needsCredits`).
    var onAddCredits: (() -> Void)? = nil

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
                if let onAddCredits {
                    Button(action: onAddCredits) {
                        Label("Add credits…", systemImage: "plus.circle")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 1)
                    .accessibilityLabel("Add credits")
                }
                if let onRetry {
                    Button(action: onRetry) {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 1)
                    .accessibilityLabel("Retry")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(bubbleBg, in: RoundedRectangle(cornerRadius: 14))
            .foregroundStyle(textColor)
            .frame(maxWidth: 320, alignment: message.role == .user ? .trailing : .leading)
            if message.role == .lisa { Spacer(minLength: 36) }
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.role == .user ? "You" : "Lisa"): \(message.text)")
    }

    private var segments: [MessageSegment] { parseSegments(message.text) }
    private var bubbleBg: Color { message.role == .user ? Theme.accent.opacity(0.18) : Theme.card }
    /// Errors read red; empty/stopped turns read muted; normal text is primary.
    private var textColor: Color {
        switch message.status {
        case .error: return Theme.danger
        case .empty, .cancelled: return Theme.secondary
        default: return Theme.text
        }
    }
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
