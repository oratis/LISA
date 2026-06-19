import SwiftUI

@MainActor
final class RosterModel: ObservableObject {
    @Published var sessions: [AgentSession] = []
    @Published var error: String?
    private var streamTask: Task<Void, Never>?

    func load(_ client: LisaClient) async {
        do {
            sessions = sortRows(try await client.sessions())
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    func startStream(_ client: LisaClient) {
        streamTask?.cancel()
        streamTask = Task { @MainActor in
            do {
                for try await msg in client.eventsStream() {
                    if (msg.type == "agent_session_update" || msg.type == "claude_session_update"),
                       let s = msg.agentSession {
                        merge(s)
                    }
                }
            } catch {
                // stream ended / dropped — the view reloads on next appear
            }
        }
    }

    func stopStream() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func merge(_ s: AgentSession) {
        if let i = sessions.firstIndex(where: { $0.id == s.id }) {
            sessions[i] = s
        } else {
            sessions.append(s)
        }
        sessions = sortRows(sessions)
    }
}

/// Permission/error first, then waiting, then working, then the rest. Newest within a bucket.
func sortRows(_ rows: [AgentSession]) -> [AgentSession] {
    func rank(_ s: AgentSession) -> Int {
        if s.activity?.pendingPermission != nil { return 0 }
        switch s.state {
        case "error": return 1
        case "waiting": return 2
        case "working": return 3
        case "done": return 5
        default: return 4
        }
    }
    return rows.sorted { a, b in
        let (ra, rb) = (rank(a), rank(b))
        if ra != rb { return ra < rb }
        return (a.lastMtime ?? "") > (b.lastMtime ?? "")
    }
}

func stateColor(_ s: AgentSession) -> Color {
    if s.activity?.pendingPermission != nil { return .orange }
    switch s.state {
    case "working": return .blue
    case "waiting": return .yellow
    case "error": return .red
    case "done": return .green
    default: return .gray
    }
}

struct RosterView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var model = RosterModel()

    var body: some View {
        NavigationStack {
            Group {
                if !app.config.isConfigured {
                    ContentUnavailableView("Not paired", systemImage: "wifi.slash",
                                           description: Text("Add your Mac in Settings."))
                } else if let err = model.error, model.sessions.isEmpty {
                    ContentUnavailableView("Can't reach Lisa", systemImage: "exclamationmark.triangle",
                                           description: Text(err))
                } else if model.sessions.isEmpty {
                    ContentUnavailableView("No agents", systemImage: "moon.zzz",
                                           description: Text("Nothing running right now."))
                } else {
                    List(model.sessions) { session in
                        NavigationLink(value: session) { RosterRow(session: session) }
                    }
                }
            }
            .navigationTitle("Dispatch")
            .navigationDestination(for: AgentSession.self) { SessionDetailView(session: $0) }
            .refreshable { await model.load(app.client) }
            .task(id: app.config) {
                await model.load(app.client)
                model.startStream(app.client)
            }
            .onDisappear { model.stopStream() }
        }
    }
}

struct RosterRow: View {
    let session: AgentSession
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(stateColor(session)).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(session.project).font(.headline).lineLimit(1)
                    Text(session.agent).font(.caption2).foregroundStyle(.secondary)
                    if let c = session.controllable {
                        Pill(text: c, color: .blue)
                    } else if session.resumable == true {
                        Pill(text: "resumable", color: .orange)
                    }
                }
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if session.activity?.pendingPermission != nil {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 2)
    }

    var subtitle: String {
        var bits: [String] = [session.state]
        if let p = session.activity?.pendingPermission { bits.append("⚠ \(p)") }
        if let t = session.activity?.turnCount { bits.append("\(t) turns") }
        if let tool = session.activity?.lastTools?.last { bits.append(tool) }
        if let branch = session.activity?.gitBranch { bits.append(branch) }
        return bits.joined(separator: " · ")
    }
}

struct Pill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}

struct SessionDetailView: View {
    let session: AgentSession
    @EnvironmentObject var app: AppState
    @State private var followUp = ""
    @State private var output = ""
    @State private var status = ""

    var body: some View {
        Form {
            Section("Session") {
                LabeledContent("Agent", value: session.agent)
                LabeledContent("Project", value: session.project)
                LabeledContent("State", value: session.stateReason.isEmpty ? session.state : "\(session.state) · \(session.stateReason)")
                if let cwd = session.cwd { LabeledContent("cwd", value: cwd) }
            }
            controlSection
            Section("Glance") {
                Button {
                    if LiveActivityController.start(for: session) != nil {
                        status = "Pinned to the Live Activity."
                    } else {
                        status = "Live Activities are unavailable here (enable in iOS Settings, or run on a device)."
                    }
                } label: {
                    Label("Pin to Live Activity", systemImage: "pin")
                }
            }
            if !status.isEmpty {
                Section { Text(status).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(session.project)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    var controlSection: some View {
        switch session.controllable {
        case "managed":
            Section("Control · managed") {
                if let pend = session.activity?.pendingPermission {
                    Text("Paused on: \(pend)").font(.subheadline)
                    HStack {
                        Button("Approve") { act { try await app.client.managedApprove(session.sessionId, allow: true) } }
                            .buttonStyle(.borderedProminent)
                        Button("Deny", role: .destructive) { act { try await app.client.managedApprove(session.sessionId, allow: false) } }
                    }
                }
                sendRow { try await app.client.managedSend(session.sessionId, $0) }
                Button("Cancel", role: .destructive) { act { try await app.client.managedCancel(session.sessionId) } }
            }
        case "pty":
            Section("Control · CLI") {
                sendRow { try await app.client.ptySend(session.sessionId, $0) }
                Button("Load output") { act { output = try await app.client.ptyOutput(session.sessionId) } }
                if !output.isEmpty {
                    ScrollView {
                        Text(output).font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 200)
                }
                Button("Cancel", role: .destructive) { act { try await app.client.ptyCancel(session.sessionId) } }
            }
        default:
            Section("Observe-only") {
                if session.resumable == true {
                    Text("This session is idle — Lisa can adopt it (claude --resume) to make it controllable.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Adopt (resume)") {
                        act {
                            let code = try await app.client.adopt(sessionId: session.sessionId)
                            switch code {
                            case 200: status = "Adopted — it'll reappear as controllable."
                            case 409: status = "That session is live — close it first."
                            case 403: status = "Remote adoption is disabled on the Mac."
                            default: status = "HTTP \(code)"
                            }
                        }
                    }
                } else {
                    Text("Live external session — observe-only (no control channel).")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    func sendRow(_ action: @escaping (String) async throws -> Void) -> some View {
        HStack {
            TextField("send a follow-up…", text: $followUp)
            Button("Send") {
                let text = followUp
                followUp = ""
                act { try await action(text) }
            }
            .disabled(followUp.isEmpty)
        }
    }

    func act(_ work: @escaping () async throws -> Void) {
        Task { @MainActor in
            do { try await work() }
            catch { status = (error as? LocalizedError)?.errorDescription ?? "\(error)" }
        }
    }
}
