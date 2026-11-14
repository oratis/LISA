import SwiftUI

struct RoomMemoryStores: Decodable {
    struct Store: Decodable {
        struct Entry: Decodable { let kind, text: String }
        let store: String
        let corrupt: Bool
        let entries: [Entry]
    }
    let stores: [Store]
}

struct RoomRequest: Decodable, Identifiable {
    let id, kind, tool, preview, reason: String
    let purpose: String?
    let targets: [String]
    var title: LocalizedStringKey { kind == "handoff" ? "Lisa needs your help" : "Lisa requests approval" }
}

struct RoomInbox: Decodable {
    let approvals: [RoomRequest]
    let canApprove: Bool
}

struct RoomRequestDetail: Decodable {
    struct Approval: Decodable { let id, digest: String; let scopes: [String] }
    struct Field: Decodable { let key, value: String }
    let approval: Approval
    let fields: [Field]
}

/// A nil source means unavailable. An empty array is a successful read with no items.
struct RoomBriefing {
    let understanding: [String]?
    let inbox: RoomInbox?
    let sessions: [AgentSession]?

    static func load(_ client: LisaClient, mac: Bool) async -> Self {
        async let memory = try? client.roomUnderstanding()
        async let inbox = try? client.roomInbox()
        async let sessions: [AgentSession]? = mac ? try? client.sessions() : []
        return await Self(understanding: memory, inbox: inbox,
                          sessions: sessions.map { sortRows($0.filter(\.needsAttention)) })
    }
}

struct RoomBriefingView: View {
    let briefing: RoomBriefing?
    let configured: Bool
    let showMemory: () -> Void
    let showRequest: (RoomRequest) -> Void
    let showSession: (AgentSession) -> Void
    @State private var expanded = false

    private var requests: [RoomRequest] { briefing?.inbox?.approvals ?? [] }
    private var sessions: [AgentSession] { briefing?.sessions ?? [] }
    private var itemCount: Int { requests.count + sessions.count }
    private let previewCount = 3

    var body: some View {
        VStack(spacing: 12) {
            Button(action: showMemory) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        heading("What Lisa knows about you", "text.book.closed")
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).accessibilityHidden(true)
                    }
                    if !configured {
                        Text("Connect to see your memories.").font(.subheadline)
                    } else if let facts = briefing?.understanding {
                        if facts.isEmpty {
                            Text("As Lisa learns your preferences, they’ll appear here.").font(.subheadline)
                        } else {
                            ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                                Text(verbatim: fact).font(.system(.body, design: .serif))
                                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    } else if briefing != nil {
                        Text("Your memories couldn’t be loaded.").font(.subheadline)
                    } else { ProgressView() }
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                .background(Theme.sage, in: RoundedRectangle(cornerRadius: 18))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("room.understanding")

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    heading("To do", "checklist")
                    Spacer()
                    if itemCount > 0 {
                        Text(itemCount, format: .number).font(.subheadline.monospacedDigit().weight(.semibold))
                    }
                }
                if !configured {
                    Text("Connect to see requests.").font(.subheadline)
                } else if let briefing {
                    ForEach(requests.prefix(expanded ? requests.count : previewCount)) { item in
                        Divider()
                        Button { showRequest(item) } label: {
                            row(item.title, detail: item.preview)
                        }.accessibilityIdentifier("room.request." + item.id)
                    }
                    ForEach(sessions.prefix(expanded ? sessions.count : max(0, previewCount - requests.count))) { session in
                        Divider()
                        Button { showSession(session) } label: {
                            row(session.activity?.pendingPermission != nil ? "Mac needs permission" :
                                    session.state == "error" ? "Mac session error" : "Mac is waiting for input",
                                detail: [agentDisplayName(session.agent), session.project, session.activity?.pendingPermission]
                                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        }.accessibilityIdentifier("room.session." + session.sessionId)
                    }
                    if itemCount > previewCount {
                        Button(expanded ? "Show fewer" : "Show all requests") { expanded.toggle() }
                            .font(.subheadline.weight(.medium)).frame(minHeight: 44)
                    }
                    if briefing.inbox == nil || briefing.sessions == nil {
                        Text("Some requests couldn’t be checked. Pull down to retry.")
                            .font(.subheadline).accessibilityIdentifier("room.todos.unavailable")
                    } else if itemCount == 0 {
                        Text("You’re all caught up.").font(.subheadline)
                            .accessibilityIdentifier("room.todos.empty")
                    }
                } else { ProgressView() }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .background(Theme.clay, in: RoundedRectangle(cornerRadius: 18))
        }
    }

    private func heading(_ title: LocalizedStringKey, _ symbol: String) -> some View {
        Label(title, systemImage: symbol).font(.headline).accessibilityAddTraits(.isHeader)
    }

    private func row(_ title: LocalizedStringKey, detail: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(verbatim: detail).font(.subheadline).lineLimit(2)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).accessibilityHidden(true)
        }.foregroundStyle(Theme.text).frame(minHeight: 44).contentShape(Rectangle())
    }
}

/// Show the server's full, digest-bound payload before offering a one-time approval.
struct RoomRequestView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    let item: RoomRequest
    let canAnswer: Bool
    @State private var detail: RoomRequestDetail?
    @State private var busy = false
    @State private var error: LocalizedStringKey?
    @State private var retry = 0

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(verbatim: item.preview)
                    if let purpose = item.purpose, !purpose.isEmpty { Text(verbatim: purpose) }
                    if !item.targets.isEmpty { Text(verbatim: item.targets.joined(separator: ", ")) }
                    if !item.reason.isEmpty { Text(verbatim: item.reason).foregroundStyle(.secondary) }
                } header: { Text(verbatim: item.tool) }
                if !canAnswer {
                    Text("Review this request on your Mac or in your signed-in Lisa account.")
                } else if let error {
                    Section {
                        Text(error)
                        Button("Try again") { retry += 1 }
                    }
                } else if item.kind == "handoff" {
                    Button("Dismiss request") { answer(digest: nil) }.disabled(busy)
                } else if let detail {
                    ForEach(Array(detail.fields.enumerated()), id: \.offset) { _, field in
                        Section { Text(verbatim: field.value).textSelection(.enabled) }
                            header: { Text(verbatim: field.key).textCase(nil) }
                    }
                } else { ProgressView() }
            }
            .consoleBackground()
            .safeAreaInset(edge: .bottom) {
                if canAnswer, item.kind == "approval", error == nil, let detail {
                    HStack(spacing: 12) {
                        Button("Deny", role: .destructive) { answer(digest: nil) }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                        Spacer(minLength: 0)
                        if detail.approval.scopes.contains("once"), !detail.approval.digest.isEmpty {
                            Button("Allow once") { answer(digest: detail.approval.digest) }
                                .buttonStyle(.borderedProminent).frame(minHeight: 44)
                        }
                    }
                    .disabled(busy).padding(16)
                    .background(Theme.panel)
                }
            }
            .navigationTitle(item.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task(id: retry) {
                error = nil
                guard canAnswer, item.kind == "approval" else { return }
                do {
                    let result = try await app.client.roomRequestDetail(item.id)
                    try Task.checkCancellation()
                    guard result.approval.id == item.id else { throw LisaError.decode }
                    detail = result
                } catch { if !Task.isCancelled { self.error = "This request couldn’t be verified. It may have closed." } }
            }
        }
    }

    private func answer(digest: String?) {
        guard canAnswer, !busy else { return }
        let client = app.client
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                try await client.answerRoomRequest(item.id, digest: digest)
                if app.client === client { dismiss() }
            } catch {
                detail = nil
                self.error = "This request couldn’t be updated. Check whether it is still open."
            }
        }
    }
}
