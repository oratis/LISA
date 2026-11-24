import SwiftUI

/// Tasks & deliverables view backed by `/api/client-capabilities` and `/api/tasks*` (A03/A04).
struct TasksView: View {
    @EnvironmentObject var app: AppState

    @State private var capabilities: ClientCapabilities?
    @State private var tasks: [LisaTask] = []
    @State private var filter = "all"
    @State private var loading = false
    @State private var error: String?

    private let filters = ["all", "routine", "watcher", "goal", "oneoff"]

    private var filteredTasks: [LisaTask] {
        if filter == "all" { return tasks }
        return tasks.filter { $0.kind == filter }
    }

    var body: some View {
        Group {
            if let cap = capabilities, !cap.tasks.isAvailable {
                ContentUnavailableView {
                    Label("Tasks unavailable here", systemImage: "checklist")
                } description: {
                    Text(cap.tasks.reason ?? "This server does not currently enable background tasks.")
                } actions: {
                    Button("Refresh") { Task { await load() } }
                        .buttonStyle(.bordered)
                }
            } else if loading && tasks.isEmpty {
                ProgressView("Loading tasks…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    Section {
                        Picker("Kind", selection: $filter) {
                            ForEach(filters, id: \.self) { kind in
                                Text(labelFor(kind)).tag(kind)
                            }
                        }
                        .pickerStyle(.segmented)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                    }

                    if let error {
                        Section {
                            Text(error).font(.caption).foregroundStyle(Theme.danger)
                        }
                    }

                    if filteredTasks.isEmpty {
                        Section {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("No tasks yet").font(.headline).foregroundStyle(Theme.text)
                                Text("Ask Lisa to schedule a routine, set a watcher, or track a goal, and inspect runs and deliverables here.")
                                    .font(.caption).foregroundStyle(Theme.secondary)
                            }
                            .padding(.vertical, 8)
                        }
                    } else {
                        Section(header: Text(capabilities?.location == "cloud" ? "LISA Cloud" : "This Mac")) {
                            ForEach(filteredTasks) { task in
                                NavigationLink {
                                    TaskDetailView(task: task, onChanged: { Task { await load() } })
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text(task.title).font(.headline).foregroundStyle(Theme.text)
                                            Spacer()
                                            Text(task.state)
                                                .font(.caption2.weight(.semibold))
                                                .padding(.horizontal, 8).padding(.vertical, 3)
                                                .background(Theme.accent.opacity(0.14), in: Capsule())
                                                .foregroundStyle(Theme.accent)
                                        }
                                        Text(task.scheduleDisplay)
                                            .font(.caption).foregroundStyle(Theme.secondary)
                                        if let milestones = task.goalMilestones, !milestones.isEmpty {
                                            let done = milestones.filter(\.done).count
                                            Text("Milestones: \(done)/\(milestones.count)")
                                                .font(.caption2).foregroundStyle(Theme.tertiary)
                                        }
                                    }
                                    .padding(.vertical, 4)
                                }
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.bgDeep.ignoresSafeArea())
        .navigationTitle("Tasks")
        .refreshable { await load() }
        .task(id: app.config) { await load() }
    }

    private func labelFor(_ kind: String) -> String {
        switch kind {
        case "all": return "All"
        case "oneoff": return "One-off"
        default: return kind.capitalized
        }
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        let cap: ClientCapabilities
        do {
            cap = try await app.client.clientCapabilities()
        } catch {
            cap = ClientCapabilities.conservativeFallback(isCloud: app.connectionMode == .cloud)
        }
        capabilities = cap
        guard cap.tasks.isAvailable else {
            tasks = []
            return
        }
        do {
            tasks = try await app.client.tasks()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct TaskDetailView: View {
    @EnvironmentObject var app: AppState
    @State var task: LisaTask
    let onChanged: () -> Void

    @State private var runs: [LisaTaskRun] = []
    @State private var busy = false
    @State private var error: String?
    @State private var preview: LisaTaskArtifactPreview?

    var body: some View {
        List {
            Section("Overview") {
                LabeledContent("Kind", value: task.kind)
                LabeledContent("State", value: task.state)
                LabeledContent("Schedule", value: task.scheduleDisplay)
                if let host = task.host { LabeledContent("Host", value: host) }
                if let next = task.nextRunAt {
                    LabeledContent("Next run", value: Date(timeIntervalSince1970: next / 1000).formatted())
                }
                Text(task.instruction).font(.callout).foregroundStyle(Theme.text)
                if let summary = task.lastSummary, !summary.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Last summary").font(.caption.weight(.semibold)).foregroundStyle(Theme.secondary)
                        Text(summary).font(.callout).foregroundStyle(Theme.text)
                    }
                }
            }

            Section("Actions") {
                Button { Task { await runNow() } } label: {
                    Label("Run now", systemImage: "play.fill")
                }.disabled(busy)
                Button { Task { await toggleEnabled() } } label: {
                    Label(task.enabled ? "Pause schedule" : "Enable schedule",
                          systemImage: task.enabled ? "pause.circle" : "checkmark.circle")
                }.disabled(busy)
                if task.activeRunId != nil {
                    Button(role: .destructive) { Task { await cancelActive() } } label: {
                        Label("Stop current run", systemImage: "stop.circle")
                    }.disabled(busy)
                }
            }

            if let milestones = task.goalMilestones, !milestones.isEmpty {
                Section("Goal milestones") {
                    ForEach(milestones) { m in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: m.done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(m.done ? Theme.green : Theme.secondary)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(m.title).font(.subheadline.weight(.medium))
                                if let ev = m.evidence, !ev.isEmpty {
                                    Text(ev).font(.caption).foregroundStyle(Theme.secondary)
                                }
                            }
                        }
                    }
                }
            }

            if let error {
                Section { Text(error).font(.caption).foregroundStyle(Theme.danger) }
            }

            Section("Recent runs") {
                if runs.isEmpty {
                    Text("No runs yet.").font(.caption).foregroundStyle(Theme.secondary)
                } else {
                    ForEach(runs) { run in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(run.state).font(.subheadline.weight(.semibold))
                                Spacer()
                                Text(Date(timeIntervalSince1970: run.startedAt / 1000).formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption).foregroundStyle(Theme.secondary)
                            }
                            if let summary = run.summary, !summary.isEmpty {
                                Text(summary).font(.caption).foregroundStyle(Theme.text)
                            }
                            if let err = run.error, !err.isEmpty {
                                Text(err).font(.caption).foregroundStyle(Theme.danger)
                            }
                            if let artifacts = run.artifacts, !artifacts.isEmpty {
                                ForEach(artifacts) { art in
                                    Button {
                                        Task { await openArtifact(runId: run.id, artifact: art) }
                                    } label: {
                                        Label(art.displayTitle, systemImage: art.kind == "link" ? "link" : "doc.text")
                                            .font(.caption.weight(.medium))
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgDeep.ignoresSafeArea())
        .navigationTitle(task.title)
        .task { await loadRuns() }
        .sheet(item: Binding(
            get: { preview.map(IdentifiablePreview.init) },
            set: { if $0 == nil { preview = nil } }
        )) { wrapped in
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let url = wrapped.preview.linkURL {
                            Link(url.absoluteString, destination: url)
                                .font(.callout)
                        } else if let text = wrapped.preview.text {
                            Text(text)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text("Binary deliverable (\(wrapped.preview.contentType), \(wrapped.preview.byteCount) bytes).")
                                .font(.callout).foregroundStyle(Theme.secondary)
                        }
                    }
                    .padding()
                }
                .navigationTitle(wrapped.preview.title)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { preview = nil }
                    }
                }
            }
        }
    }

    private func loadRuns() async {
        do { runs = try await app.client.taskRuns(task.id) }
        catch { self.error = error.localizedDescription }
    }

    private func runNow() async {
        busy = true; error = nil; defer { busy = false }
        do {
            if let updated = try await app.client.runTask(task.id) { task = updated }
            onChanged()
            await loadRuns()
        } catch { self.error = error.localizedDescription }
    }

    private func toggleEnabled() async {
        busy = true; error = nil; defer { busy = false }
        do {
            task = try await app.client.setTaskEnabled(task.id, enabled: !task.enabled)
            onChanged()
        } catch { self.error = error.localizedDescription }
    }

    private func cancelActive() async {
        busy = true; error = nil; defer { busy = false }
        do {
            if let updated = try await app.client.cancelTask(task.id) { task = updated }
            onChanged()
            await loadRuns()
        } catch { self.error = error.localizedDescription }
    }

    private func openArtifact(runId: String, artifact: LisaTaskArtifact) async {
        error = nil
        do {
            preview = try await app.client.taskArtifactPreview(taskId: task.id, runId: runId, artifact: artifact)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct IdentifiablePreview: Identifiable {
    let id = UUID()
    let preview: LisaTaskArtifactPreview
}
