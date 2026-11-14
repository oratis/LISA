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
    var expression: ConversationExpression?
    var expressionLive = false
    var status: Status = .ok
    /// The turn died because the session allowance is spent (HTTP 402). Drives
    /// the inline "Add credits…" button — a second route to the In-App
    /// Purchases that doesn't depend on the Settings quota card rendering.
    var needsCredits: Bool = false
    /// The turn was refused because the account session is no longer valid.
    var needsSignIn: Bool = false
    /// The connection dropped mid-turn (not the user's Stop): on returning to
    /// the foreground the transcript is re-read in case the reply landed (#491).
    var dropped: Bool = false
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
    /// True once the user tapped Stop for the current turn, so a socket closed
    /// for any other reason isn't reported as "Stopped." (#487).
    private var userStopped = false
    /// Failures every screen should know about (an expired session) go to AppState.
    var onFailure: (@MainActor (Error) -> Void)?

    /// The text Retry sends again: the last thing the user said this session,
    /// or the newest user message in the loaded history.
    var retryText: String? {
        lastUserText ?? messages.last(where: { $0.role == .user })?.text
    }

    func markExpressionSeen(_ id: UUID) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].expressionLive = false
    }

    // ── history ──
    func loadHistory(_ client: LisaClient) async {
        guard messages.isEmpty else { return }
        let r: HistoryResponse
        do { r = try await client.history(page: 0) } catch { onFailure?(error); return }
        messages = r.messages.compactMap(Self.map)
        page = 0
        hasMore = r.hasMore
    }

    /// Back in the foreground after a turn dropped: the server may have
    /// finished it, so re-read the newest page and keep it if it has a reply.
    func recoverDroppedTurn(_ client: LisaClient) async {
        guard !sending, let last = messages.last, last.role == .lisa, last.dropped else { return }
        let before = messages
        guard let r = try? await client.history(page: 0), !sending, messages == before else { return }
        let recovered = r.messages.compactMap(Self.map)
        let expectedUsers = Array(before.filter { $0.role == .user }.suffix(2).map(\.text))
        guard !expectedUsers.isEmpty, recovered.last?.role == .lisa,
              Array(recovered.filter { $0.role == .user }.suffix(expectedUsers.count).map(\.text)) == expectedUsers else { return }
        messages = recovered
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
        guard !m.content.isEmpty || !m.tools.isEmpty || m.expression != nil else { return nil }
        return ChatMessage(role: m.role == "user" ? .user : .lisa, text: m.expression == nil ? m.content : "", tools: m.tools, expression: m.expression)
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
                } catch {
                    // A rejected credential won't fix itself: stop retrying and
                    // let the app ask for sign-in. Anything else reconnects.
                    if Self.stopsRetrying(error) { onFailure?(error); break }
                }
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: backoffSec * 1_000_000_000)
                backoffSec = min(backoffSec * 2, 30)
            }
        }
    }
    func stopMood() { moodTask?.cancel(); moodTask = nil }

    /// Errors after which reconnecting the status stream can't succeed.
    static func stopsRetrying(_ error: Error) -> Bool {
        if let status = error.httpStatus, status == 401 || status == 403 { return true }
        if let link = error as? RemoteLinkError, link == .signIn || link == .notAllowed { return true }
        return false
    }

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
        guard let text = retryText, !sending else { return }
        lastUserText = text
        if let last = messages.last, last.role == .lisa, last.isRetryable {
            messages.removeLast()
        }
        runTurn(text, client: client)
    }

    /// Stop the in-flight turn. Cancelling the task tears down the SSE stream,
    /// which also closes the connection so the Mac can abort the agent.
    func cancel() {
        if sending { userStopped = true }
        task?.cancel()
    }

    private func runTurn(_ userText: String, client: LisaClient) {
        messages.append(ChatMessage(role: .lisa, status: .streaming))
        let idx = messages.count - 1
        let config = client.config
        sending = true
        userStopped = false
        task = Task { @MainActor in
            defer { sending = false }
            do {
                for try await msg in client.chatStream(userText) {
                    guard messages.indices.contains(idx) else { break }
                    switch msg.type {
                    case "text":
                        if let t = msg.text, !t.isEmpty { messages[idx].text += t }
                    case "expression":
                        if let expression = ConversationExpression.decode(msg.object["expression"]), messages[idx].expression?.id != expression.id {
                            messages[idx].expression = expression; messages[idx].expressionLive = true
                        }
                    case "tool_start":
                        if let n = msg.object["name"] as? String, n != "reply_expression", !messages[idx].tools.contains(n) {
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
                markFailed(idx, error, config: config)
            }
        }
    }

    /// A cleanly-finished stream: decide the terminal status. Text/tools ⇒ ok;
    /// otherwise it's an empty turn (retryable, not an error).
    private func resolveEnding(_ idx: Int) {
        guard messages.indices.contains(idx), messages[idx].status == .streaming else { return }
        if messages[idx].text.isEmpty && messages[idx].tools.isEmpty && messages[idx].expression == nil {
            messages[idx].status = .empty
            messages[idx].text = "Lisa didn't reply."
        } else {
            messages[idx].status = .ok
        }
    }

    /// The gateway refuses an unaffordable turn with a clean 402 before it
    /// streams anything. Only a spent allowance or a premium model without
    /// balance is fixed by buying credits; `service_paused` is also a 402 and
    /// must never send people to the paywall (#485). An older server's bare 402
    /// meant the allowance.
    static func isQuotaExhausted(_ error: Error) -> Bool {
        guard let failure = error.serverFailure, failure.status == 402 else { return false }
        return failure.code.isEmpty || failure.code == "quota_exhausted" || failure.code == "premium_requires_balance"
    }

    /// A thrown stream: the user's own Stop reads as `.cancelled`; anything else
    /// is a real error with its own explanation. Either way it's retryable.
    private func markFailed(_ idx: Int, _ error: Error, config: ServerConfig) {
        guard messages.indices.contains(idx) else { return }
        let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
        if cancelled && (userStopped || error is CancellationError) {
            messages[idx].status = .cancelled
            if messages[idx].text.isEmpty { messages[idx].text = "Stopped." }
            return
        }
        messages[idx].status = .error
        if Self.isQuotaExhausted(error) {
            // Same copy as the web paywall (strings.ts), minus the "go to
            // Settings" pointer — the button below opens the packs.
            messages[idx].needsCredits = true
            messages[idx].text = error.serverFailure?.code == "premium_requires_balance"
                ? "This model needs account credits. Add credits, or switch to a standard model."
                : "Your free allowance for today is used up — it refreshes every 24 hours. Add credits to keep going now."
            return
        }
        if cancelled || error is URLError || (error as? RemoteLinkError) == .interrupted {
            // The connection closed under the turn (network change, timeout).
            messages[idx].dropped = true
            let note = "The connection dropped before Lisa finished. Try again."
            messages[idx].text += (messages[idx].text.isEmpty ? "" : "\n") + note
            return
        }
        let problem = ConnectionProblem.classify(error, config: config)
        if problem == .signInRequired { messages[idx].needsSignIn = true }
        onFailure?(error)
        let msg = problem.sentence ?? (error as? LocalizedError)?.errorDescription ?? "Couldn't reach Lisa."
        messages[idx].text += (messages[idx].text.isEmpty ? "" : "\n") + msg
    }
}

struct ChatView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject var app: AppState
    @StateObject private var model = ChatModel()
    @State private var input = ""
    @FocusState private var composerFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showPaywall = false
    @StateObject private var aiGate = AISharingGate()
    @State private var loadedConfig: ServerConfig?
    private static let starterArtwork = Bundle.main.url(forResource: "lisa-make-a-plan", withExtension: "png")
        .flatMap { UIImage(contentsOfFile: $0.path) }
    private static let bottomID = "chat-bottom"

    private func refreshExpressions() async {
        let expected = app.config
        if let prefs = try? await app.client.expressionPreferences(), !Task.isCancelled, app.config == expected { app.expressionPreferences = prefs }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                transcript
                if app.config.isConfigured {
                VStack(alignment: .leading, spacing: 6) {
                    Label {
                        if app.aiConsent.isGranted(for: .chat) {
                            Text("AI data sharing allowed: \(app.aiConsent.recipients.joined(separator: ", "))")
                        } else {
                            Text("Before your first message, review and allow sharing with third-party AI.")
                        }
                    } icon: { Image(systemName: "hand.raised") }
                    .font(.caption).foregroundStyle(Theme.secondary)
                    composer
                }
                .padding(.horizontal, Theme.Space.m).padding(.vertical, 8)
                .frame(maxWidth: Theme.readingWidth)
                }
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
                model.onFailure = { [weak app = app] error in app?.noteFailure(error) }
                model.startMood(app.client)
                await model.loadHistory(app.client)
            }
            .task(id: app.config) {
                app.expressionPreferences = ExpressionPreferences()
                await refreshExpressions()
            }
            .onDisappear {
                model.stopMood()
                if loadedConfig != app.config { model.cancel() }
            }
            .onAppear { consumeDraft(); Task { await refreshExpressions() } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task {
                    await refreshExpressions()
                    await model.recoverDroppedTurn(app.client)
                } }
            }
            // Keep what was typed across the re-sign-in the banner offers.
            .onChange(of: app.sessionExpired) { _, expired in
                if expired { app.stashDraftForSignIn(input) }
            }
            .onChange(of: model.sending) { _, sending in
                if !sending { Task { await refreshExpressions() } }
            }
            .onChange(of: app.chatDraft) { _, _ in consumeDraft() }
            // TabView keeps this view alive off-screen; never leave its keyboard up.
            .onChange(of: app.selectedTab) { _, _ in composerFocused = false }
            .onChange(of: app.showOnboarding) { _, showing in if showing { composerFocused = false } }
            // The gate drops its own sheet and pending check; the stream is the model's.
            .onChange(of: app.aiConsent.generation) { _, _ in model.cancel() }
            .sheet(isPresented: $showPaywall) { PaywallSheet().environmentObject(app) }
            .aiSharingConsent(aiGate, app: app)
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
                Text("Lisa").font(Theme.title(.headline)).foregroundStyle(Theme.text)
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

    private func startDraft(_ starter: AssistantStarter) {
        input = starter.prompt
        composerFocused = true
    }

    private var transcript: some View {
        GeometryReader { viewport in
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
                            emptyState.padding(.vertical, Theme.Space.l)
                                .frame(minHeight: max(0, viewport.size.height - 2 * Theme.Space.m - 1))
                        }
                        ForEach(model.messages) { msg in
                            // A blank streaming bubble is stood in for by the typing
                            // indicator below — don't render an empty bubble.
                            if !isWaitingBubble(msg) && !(msg.expression != nil && msg.text.isEmpty && msg.tools.isEmpty && app.expressionPreferences.display == .off) {
                                MessageBubble(
                                    message: msg,
                                    onRetry: retryAction(for: msg),
                                    onAddCredits: msg.needsCredits ? { showPaywall = true } : nil,
                                    onSignIn: msg.needsSignIn ? { app.stashDraftForSignIn(input); app.beginSignInAgain() } : nil,
                                    expressionClient: app.client, expressionPreferences: app.expressionPreferences,
                                    onExpressionStarted: { model.markExpressionSeen(msg.id) }
                                )
                            }
                        }
                        if showTyping {
                            TypingIndicator().frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, Theme.Space.l).padding(.vertical, Theme.Space.m)
                    .frame(maxWidth: Theme.readingWidth)
                    .frame(maxWidth: .infinity)
                    Color.clear.frame(height: 1).id(Self.bottomID)
                }
                .accessibilityIdentifier("chat.transcript")
                .scrollDismissesKeyboard(.interactively)
                .scrollBounceBehavior(.always)
                .contentShape(Rectangle())
                .onTapGesture { composerFocused = false }
                .onChange(of: model.messages.last) { _, last in
                    if last != nil { scrollToBottom(proxy) }
                }
                .onChange(of: model.sending) { _, _ in scrollToBottom(proxy) }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(spacing: 8) {
                if let art = Self.starterArtwork {
                    Image(uiImage: art).resizable().scaledToFit()
                        .frame(width: 104, height: 104).accessibilityHidden(true)
                }
                Text(app.config.isConfigured ? "What’s on your mind?" : "Connect Lisa to start chatting").font(Theme.title(.title))
                    .foregroundStyle(Theme.text).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity).padding(.bottom, 8)
            if !app.config.isConfigured {
                Text("Sign in to LISA Cloud or connect your Mac first.")
                    .font(.callout).foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                Button("Get started") { composerFocused = false; app.presentOnboarding() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("chat.getStarted")
                    .frame(maxWidth: .infinity)
            } else if input.trimmed.isEmpty && !composerFocused {
                VStack(spacing: 0) {
                    ForEach(AssistantStarter.all) { starter in
                        if starter.id != AssistantStarter.all.first?.id { Divider().padding(.leading, 48) }
                        Button { startDraft(starter) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: starter.icon).frame(width: 24).foregroundStyle(Theme.accent)
                                Text(starter.title).foregroundStyle(Theme.text)
                                Spacer()
                                Image(systemName: "arrow.up.left").font(.caption).foregroundStyle(Theme.tertiary)
                            }
                            .padding(.horizontal, 16).frame(minHeight: 50).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Adds an editable draft. Tap Send when ready.")
                    }
                }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
                .overlay { RoundedRectangle(cornerRadius: Theme.cardRadius).strokeBorder(Theme.border, lineWidth: Theme.hairline) }
            }
        }.frame(maxWidth: 430)
    }

    /// A Lisa turn that's mid-stream with nothing to show yet.
    private func isWaitingBubble(_ msg: ChatMessage) -> Bool {
        msg.role == .lisa && msg.status == .streaming && msg.text.isEmpty && msg.tools.isEmpty && msg.expression == nil
    }

    /// Show the typing indicator while the newest Lisa turn hasn't produced anything.
    private var showTyping: Bool {
        guard model.sending, let last = model.messages.last else { return false }
        return isWaitingBubble(last)
    }

    /// Offer Retry only on the newest turn, when it ended with nothing useful.
    /// Retry replaces the failed reply; it never adds a second copy of the
    /// user's message (#491).
    private func retryAction(for msg: ChatMessage) -> (() -> Void)? {
        guard !model.sending, msg.role == .lisa, msg.isRetryable, !msg.needsSignIn,
              msg.id == model.messages.last?.id else { return nil }
        return { requestRetry() }
    }

    private func requestRetry() {
        guard !model.sending, let text = model.retryText, !text.trimmed.isEmpty else { return }
        aiGate.submit(text, purpose: .chat, app: app) { _ in
            app.cancelActiveChat = { [weak model = model] in model?.cancel() }
            model.resend(client: app.client)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 4) {
            if composerFocused {
                Button { composerFocused = false } label: {
                    Image(systemName: "keyboard.chevron.compact.down").font(.title3)
                        .frame(width: 44, height: 44)
                }
                .foregroundStyle(Theme.secondary)
                .accessibilityLabel("Hide keyboard")
                .accessibilityIdentifier("chat.hideKeyboard")
            }
            if !composerFocused && !model.messages.isEmpty && input.trimmed.isEmpty && !model.sending {
                Menu {
                    ForEach(AssistantStarter.all) { starter in
                        Button { startDraft(starter) } label: { Label(starter.title, systemImage: starter.icon) }
                    }
                } label: {
                    Image(systemName: "sparkles").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Writing suggestions")
            }
            TextField("Message…", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .focused($composerFocused)
                .padding(.leading, 10).padding(.vertical, 11)
                .foregroundStyle(Theme.text)
                .accessibilityLabel("Message Lisa")
                .accessibilityIdentifier("chat.composer")
                .lineLimit(1...5)
                .onSubmit(sendCurrent)
            if model.sending {
                Button { model.cancel() } label: {
                    Image(systemName: "stop.circle.fill").font(.title)
                        .frame(width: 44, height: 44)
                }
                .foregroundStyle(Theme.danger)
                .accessibilityLabel("Stop")
                .accessibilityHint("Stops Lisa's reply")
            } else {
                Button(action: sendCurrent) {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Send message")
                .accessibilityHint("Sends what you typed to Lisa")
                .disabled(input.trimmed.isEmpty || aiGate.busy || !app.config.isConfigured)
            }
        }
        .padding(4)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 24))
        .overlay { RoundedRectangle(cornerRadius: 24).strokeBorder(composerFocused ? Theme.accent : Theme.border, lineWidth: composerFocused ? 1.5 : Theme.hairline) }
    }

    private func sendCurrent() {
        requestSend(input)
    }

    private func requestSend(_ text: String) {
        guard !model.sending, !text.trimmed.isEmpty else { return }
        aiGate.submit(text, purpose: .chat, app: app) { text in deliver(text) }
    }

    /// Runs only from the gate, after it rechecked the consent for this send.
    private func deliver(_ text: String) {
        app.cancelActiveChat = { [weak model = model] in model?.cancel() }
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
    /// Present when the turn was refused because the session expired.
    var onSignIn: (() -> Void)? = nil
    var expressionClient: LisaClient? = nil
    var expressionPreferences = ExpressionPreferences()
    var onExpressionStarted: (() -> Void)? = nil

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 36) }
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                    switch seg {
                    case .text(let t):
                        Text(renderMarkdown(t)).font(.body).lineSpacing(3).textSelection(.enabled)
                    case .code(let c):
                        CodeBlock(text: c)
                    }
                }
                if let expression = message.expression, let client = expressionClient {
                    ConversationExpressionView(expression: expression, client: client, preferences: expressionPreferences, live: message.expressionLive, onPlaybackStarted: onExpressionStarted)
                }
                if !message.tools.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Theme.Space.xs) {
                            ForEach(message.tools, id: \.self) { tool in
                                ThemePill(text: tool, color: Theme.accent)
                            }
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
                if let onSignIn {
                    Button(action: onSignIn) {
                        Label("Sign in again", systemImage: "person.crop.circle")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 1)
                    .accessibilityLabel("Sign in again")
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
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(bubbleBg, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius).strokeBorder(Theme.border, lineWidth: Theme.hairline))
            .foregroundStyle(textColor)
            .frame(maxWidth: 560, alignment: message.role == .user ? .trailing : .leading)
            if message.role == .lisa { Spacer(minLength: 36) }
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.role == .user ? "You" : "Lisa"): \(message.text)")
    }

    private var segments: [MessageSegment] { parseSegments(message.text) }
    private var bubbleBg: Color { message.role == .user ? Theme.userBubble : Theme.card }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var animate = false
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { i in
                Circle().fill(Theme.secondary).frame(width: 7, height: 7)
                    .scaleEffect(animate ? 1 : 0.5)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.5).repeatForever().delay(Double(i) * 0.15), value: animate)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .onAppear { animate = !reduceMotion }
        .onChange(of: reduceMotion) { _, reduced in animate = !reduced }
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
