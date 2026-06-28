import SwiftUI
import WidgetKit

@MainActor
final class RosterModel: ObservableObject {
    @Published var sessions: [AgentSession] = []
    @Published var error: String?
    private var streamTask: Task<Void, Never>?

    func load(_ client: LisaClient) async {
        do {
            sessions = sortRows(try await client.sessions())
            error = nil
            publishSnapshot()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    func startStream(_ client: LisaClient) {
        streamTask?.cancel()
        streamTask = Task { @MainActor in
            var backoffSec: UInt64 = 1
            while !Task.isCancelled {
                do {
                    for try await msg in client.eventsStream() {
                        backoffSec = 1  // healthy traffic resets the backoff
                        if (msg.type == "agent_session_update" || msg.type == "claude_session_update"),
                           let s = msg.agentSession {
                            merge(s)
                        }
                    }
                } catch {
                    // dropped — fall through to a full resync + backed-off reconnect
                }
                if Task.isCancelled { break }
                await load(client)  // catch transitions missed during the gap
                try? await Task.sleep(nanoseconds: backoffSec * 1_000_000_000)
                backoffSec = min(backoffSec * 2, 30)  // 1,2,4,…,30s cap
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
        publishSnapshot()
        LiveActivityController.update(for: s)   // tick / auto-end a pinned activity (A3)
    }

    /// Mirror the roster's counts (metadata only — no session content) to the App
    /// Group so the home-screen Widget can render them, then nudge it to reload.
    private func publishSnapshot() {
        SharedStore.writeSnapshot(rosterCounts(sessions))
        WidgetCenter.shared.reloadAllTimelines()
    }
}

/// Bucket roster sessions into the Widget's counts (pending-permission and
/// "waiting" both count as needs-you). Pure — unit-tested.
func rosterCounts(_ sessions: [AgentSession], at now: Date = Date()) -> AgentSnapshot {
    var working = 0, waiting = 0, error = 0
    for s in sessions {
        if s.activity?.pendingPermission != nil || s.state == "waiting" { waiting += 1 }
        else if s.state == "error" { error += 1 }
        else if s.state == "working" { working += 1 }
    }
    return AgentSnapshot(working: working, waiting: waiting, error: error, total: sessions.count, updatedAt: now)
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
    if s.activity?.pendingPermission != nil { return Theme.waiting }
    switch s.state {
    case "working": return Theme.working
    case "waiting": return Theme.waiting
    case "error": return Theme.danger
    case "done": return Theme.done
    default: return Theme.idle
    }
}

struct RosterView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var model = RosterModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [AgentSession] = []
    @State private var showDelegate = false
    @State private var policy: ControlPolicy?

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                if app.config.isConfigured { ProactiveBanner() }
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
                        agentSections
                    }
                }
            }
            .background(Theme.bgDeep.ignoresSafeArea())
            .navigationTitle("Agents")
            .navigationDestination(for: AgentSession.self) { SessionDetailView(session: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showDelegate = true } label: { Image(systemName: "plus") }
                        .disabled(!app.config.isConfigured)
                        .accessibilityLabel("Delegate a task")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink { DispatchLedgerView() } label: {
                        Image(systemName: "list.bullet.rectangle")
                    }
                }
            }
            .sheet(isPresented: $showDelegate) {
                DelegateSheet(client: app.client) { Task { await model.load(app.client) } }
            }
            .refreshable { await model.load(app.client) }
            .task(id: app.config) {
                await model.load(app.client)
                await app.loadProactive()
                policy = try? await app.client.controlPolicy()
                resolvePending()
                model.startStream(app.client)
            }
            .onChange(of: scenePhase) { _, phase in
                // iOS suspends SSE in the background; on return to foreground do a
                // full resync and reconnect so the roster is correct + live again.
                // Skip while the Face ID lock is up — don't fetch behind the gate.
                guard phase == .active, app.config.isConfigured, !app.locked else { return }
                Task { await model.load(app.client); await app.loadProactive(); model.startStream(app.client) }
            }
            // Deep-link (push Click / widget): open the requested session once it's
            // in the roster — handle either arrival order (link before/after load).
            .onChange(of: app.pendingSession) { _, _ in resolvePending() }
            .onChange(of: model.sessions) { _, _ in resolvePending() }
            .onDisappear { model.stopStream() }
        }
    }

    /// If a deep-link is pending and its session is in the roster, push it once.
    private func resolvePending() {
        guard let p = app.pendingSession,
              let match = model.sessions.first(where: { $0.agent == p.agent && $0.sessionId == p.id })
        else { return }
        path = [match]
        app.pendingSession = nil
    }

    /// Needs-you-first sections (redesign): blocked/errored/waiting agents float to
    /// the top as action cards (inline approve/deny), running ones are a compact
    /// list, and idle/done collapse behind a disclosure.
    private var agentSections: some View {
        let needs = model.sessions.filter(needsYou)
        let running = model.sessions.filter { $0.state == "working" && !needsYou($0) }
        let resting = model.sessions.filter { !needsYou($0) && $0.state != "working" }
        return List {
            if !needs.isEmpty {
                Section {
                    ForEach(needs) { s in
                        NeedsYouCard(session: s, canControl: policy?.remoteControl ?? true) { path.append(s) }
                            .listRowBackground(Theme.card)
                    }
                } header: { Text("Needs you · \(needs.count)").foregroundStyle(Theme.waiting) }
            }
            if !running.isEmpty {
                Section("Running · \(running.count)") {
                    ForEach(running) { s in
                        NavigationLink(value: s) { RosterRow(session: s) }.listRowBackground(Theme.card)
                    }
                }
            }
            if !resting.isEmpty {
                Section {
                    DisclosureGroup("Idle & done · \(resting.count)") {
                        ForEach(resting) { s in
                            NavigationLink(value: s) { RosterRow(session: s) }.listRowBackground(Theme.card)
                        }
                    }
                }
            }
        }
        .consoleBackground()
    }

    private func needsYou(_ s: AgentSession) -> Bool {
        s.activity?.pendingPermission != nil || s.state == "waiting" || s.state == "error"
    }
}

/// An agent that needs your attention, as an action card: project/agent + what
/// it's stuck on, with inline Approve / Deny for a paused managed agent (gated by
/// the Mac's control policy) — no drilling in. Tap "Open" for the full detail.
struct NeedsYouCard: View {
    @EnvironmentObject var app: AppState
    let session: AgentSession
    let canControl: Bool
    let onOpen: () -> Void
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(spacing: 8) {
                StatusDot(color: stateColor(session))
                Text(session.project).font(.subheadline.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                Text(session.agent).font(.caption2).foregroundStyle(Theme.secondary)
                Spacer()
                Button(action: onOpen) {
                    HStack(spacing: 2) { Text("Open"); Image(systemName: "chevron.right") }
                        .font(.caption).foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            }
            if let pend = session.activity?.pendingPermission {
                Text("Paused on: \(pend)").font(.caption).foregroundStyle(Theme.secondary)
                if session.controllable == "managed" {
                    HStack(spacing: Theme.Space.s) {
                        Button("Approve") { act(allow: true) }
                            .buttonStyle(.borderedProminent).tint(Theme.green)
                        Button("Deny", role: .destructive) { act(allow: false) }
                            .buttonStyle(.bordered)
                        if !canControl {
                            Text("remote control off").font(.caption2).foregroundStyle(Theme.waiting)
                        }
                    }
                    .disabled(!canControl || busy)
                    .font(.caption)
                }
            } else if session.state == "error" {
                Text(session.stateReason.isEmpty ? "Errored — tap Open to inspect." : session.stateReason)
                    .font(.caption).foregroundStyle(Theme.danger)
            } else {
                Text("Waiting on input.").font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }

    private func act(allow: Bool) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                try await app.client.managedApprove(session.sessionId, allow: allow)
                app.notify(allow ? "Approved." : "Denied.")
            } catch {
                app.notify((error as? LocalizedError)?.errorDescription ?? "Action failed.", ok: false)
            }
        }
    }
}

struct RosterRow: View {
    let session: AgentSession
    var body: some View {
        HStack(spacing: 10) {
            StatusDot(color: stateColor(session))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(session.project).font(.headline).foregroundStyle(Theme.text).lineLimit(1)
                    Text(session.agent).font(.caption2).foregroundStyle(Theme.secondary)
                    if let c = session.controllable {
                        ThemePill(text: c, color: Theme.accent)
                    } else if session.resumable == true {
                        ThemePill(text: "resumable", color: Theme.waiting)
                    }
                }
                Text(subtitle).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            Spacer()
            if session.activity?.pendingPermission != nil {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.waiting)
            }
        }
        .padding(.vertical, 2)
        // One VoiceOver element — status isn't color-only (D1/D5).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(rowLabel)
    }

    private var rowLabel: String {
        var s = "\(session.project), \(session.agent), \(session.state)"
        if let p = session.activity?.pendingPermission { s += ", needs you: \(p)" }
        else if session.resumable == true { s += ", resumable" }
        return s
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

/// Green "Proactive mode" banner at the top of Dispatch — echoes the web app's
/// proactive panel. The toggle controls real autonomy via /api/autonomy/state.
struct ProactiveBanner: View {
    @EnvironmentObject var app: AppState
    var body: some View {
        HStack(spacing: 12) {
            StatusDot(color: app.proactiveEnabled ? Theme.green : Theme.idle, size: 11)
            VStack(alignment: .leading, spacing: 2) {
                Text("Proactive").font(.subheadline.weight(.medium)).foregroundStyle(Theme.text)
                Text(app.proactiveEnabled ? "Lisa acts on her own when idle" : "Lisa waits for you")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
            Spacer()
            Toggle("", isOn: Binding(get: { app.proactiveEnabled }, set: { app.setProactive($0) }))
                .labelsHidden()
                .tint(Theme.green)
                .disabled(app.proactiveBusy || !app.proactiveAvailable)
        }
        .padding(14)
        .background(Theme.green.opacity(0.10), in: RoundedRectangle(cornerRadius: Theme.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius).strokeBorder(Theme.green.opacity(0.35), lineWidth: Theme.hairline))
        .padding(.horizontal).padding(.top, 8).padding(.bottom, 4)
    }
}

/// Agents · Working · Needs-you stat strip — counts derived from the already-loaded
/// roster via the pure `rosterCounts` helper (no extra network call).
struct StatStrip: View {
    let counts: AgentSnapshot
    var body: some View {
        HStack(spacing: 10) {
            StatCell(value: counts.total, label: "Agents", tint: Theme.accent)
            StatCell(value: counts.working, label: "Working", tint: Theme.green)
            StatCell(value: counts.waiting, label: "Needs you", tint: Theme.waiting)
        }
        .padding(.horizontal).padding(.bottom, 8)
    }
}

/// Start a new agent: managed (Lisa runs it) or a real claude/codex CLI under a
/// PTY. Mirrors the Mac GUI's "delegate a task" modal.
struct DelegateSheet: View {
    let client: LisaClient
    var onStarted: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "managed"
    @State private var task = ""
    @State private var status = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
                    Picker("Agent", selection: $kind) {
                        Text("managed — Lisa runs it").tag("managed")
                        Text("claude — real CLI (PTY)").tag("claude")
                        Text("codex — real CLI (PTY)").tag("codex")
                    }
                    .pickerStyle(.menu)
                }
                Section("Task") {
                    TextField("Describe the task…", text: $task, axis: .vertical)
                        .lineLimit(3...8)
                }
                if !status.isEmpty {
                    Section { Text(status).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Delegate a task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { start() }
                        .disabled(busy || task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func start() {
        let t = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        busy = true
        status = ""
        Task { @MainActor in
            do {
                if kind == "managed" {
                    try await client.managedStart(task: t)
                } else {
                    let code = try await client.ptyStart(agent: kind, task: t)
                    if !(200..<300).contains(code) {
                        busy = false
                        status = code == 503
                            ? "PTY agents are disabled on the Mac (set LISA_PTY_AGENTS=1)."
                            : "Couldn't start (HTTP \(code))."
                        return
                    }
                }
                onStarted()
                dismiss()
            } catch {
                busy = false
                status = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }
}

struct SessionDetailView: View {
    let session: AgentSession
    @EnvironmentObject var app: AppState
    @State private var followUp = ""
    @State private var output = ""
    @State private var status = ""
    @State private var policy: ControlPolicy?   // nil = not yet loaded (optimistic)

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
                    if LiveActivityController.start(for: session, client: app.client) != nil {
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
        .task { policy = try? await app.client.controlPolicy() }   // gate remote control (A8)
    }

    /// This phone is always a remote (non-loopback) caller, so the Mac's control
    /// policy decides whether it may control at all (A8). nil = not yet loaded ⇒
    /// optimistic (a brief 403 is now surfaced rather than swallowed).
    private var canControl: Bool { policy?.remoteControl ?? true }
    private var canAdopt: Bool { policy?.remoteAdoptExternal ?? true }
    /// A finished/idle session 404s on send/cancel — don't offer live controls (A9).
    private var isTerminal: Bool { ["done", "idle"].contains(session.state) }

    @ViewBuilder private var remoteBlockedNote: some View {
        Text("Remote control is disabled on this Mac — enable it from the Mac (control policy).")
            .font(.caption).foregroundStyle(Theme.waiting)
    }

    @ViewBuilder
    var controlSection: some View {
        switch session.controllable {
        case "managed":
            Section("Control · managed") {
                if isTerminal {
                    Text("This session has finished — no controls.").font(.caption).foregroundStyle(.secondary)
                } else {
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
                    if !canControl { remoteBlockedNote }
                }
            }
            .disabled(!isTerminal && !canControl)
        case "pty":
            Section("Control · CLI") {
                if isTerminal {
                    Text("This session has finished — no controls.").font(.caption).foregroundStyle(.secondary)
                } else {
                    sendRow { try await app.client.ptySend(session.sessionId, $0) }
                    Button("Cancel", role: .destructive) { act { try await app.client.ptyCancel(session.sessionId) } }
                    if !canControl { remoteBlockedNote }
                }
                Button("Load output") { act { output = try await app.client.ptyOutput(session.sessionId) } }
                if !output.isEmpty {
                    CodeBlock(text: output, maxHeight: 200)
                }
            }
            .disabled(!isTerminal && !canControl)
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
                    .disabled(!canAdopt)
                    if !canAdopt {
                        Text("Remote adoption is disabled on the Mac (remoteAdoptExternal off).")
                            .font(.caption).foregroundStyle(Theme.waiting)
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
            do { try await work(); Haptics.success() }
            catch {
                // A1 surfaces non-2xx here; make the failure land visibly (J1).
                let msg = (error as? LocalizedError)?.errorDescription ?? "Action failed."
                status = msg
                app.notify(msg, ok: false)
            }
        }
    }
}
