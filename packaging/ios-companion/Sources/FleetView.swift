import SwiftUI

/// The currently selected Mac only. A different account/Mac gets fresh state and cursors.
struct FleetPocketView: View {
    @EnvironmentObject var app: AppState
    var body: some View {
        if let mac = app.config.remoteMac {
            FleetPocketContent(client: app.client, macName: mac.name)
                .id(app.config)
        } else {
            ContentUnavailableView("Connect your Mac", systemImage: "desktopcomputer",
                                   description: Text("Choose a paired Mac in Settings to view its shared Fleet tasks."))
        }
    }
}

private struct FleetPocketContent: View {
    let client: LisaClient
    let macName: String
    @EnvironmentObject var app: AppState
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = FleetPocketModel()
    @State private var reviewing: FleetTask?
    private var active: Bool { scenePhase == .active && !app.locked }

    var body: some View {
        List {
            Section {
                Text("Current Mac: \(macName)")
                SavedMacPicker()
                Text("Tasks shared with this Pocket are read only unless the Mac separately grants approval access.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let message = model.message { Text(message).font(.footnote) }
            }
            if model.runs.isEmpty {
                Text("No shared tasks. On this Mac, open Remote Macs → Configure this Mac → Pocket, then grant access to a task.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.runs) { run in
                Button { model.selection = run.id } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(run.workspaceName + " · " + run.id.prefix(8))
                        Text((run.agent ?? "claude-code") + " · " + run.state + " · " + run.accessLabel).font(.subheadline)
                        Text(Date(timeIntervalSince1970: run.updatedAt / 1000), style: .relative)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Fleet · \(macName)")
        .navigationDestination(item: $model.selection) { _ in
            List {
                Section {
                    Text(macName + " · " + (model.timeline.run?.accessLabel ?? String(localized: "Read only")))
                    if let message = model.decisionMessage { Text(message).font(.footnote) }
                    if let message = model.message { Text(message).font(.footnote) }
                    if let run = model.timeline.run {
                        Text(run.workspaceName + " · " + (run.agent ?? "claude-code") + " · " + run.state)
                        Text("Updated \(Date(timeIntervalSince1970: run.updatedAt / 1000).formatted())")
                            .font(.caption).foregroundStyle(.secondary)
                        if let approval = run.approval {
                            Text("Waiting for approval: \(approval.tool) \(approval.target)")
                            if run.canApprove {
                                Button("Review request") { reviewing = run }
                                    .disabled(!active || !model.canDecide(run))
                                    .accessibilityIdentifier("fleet.review-approval")
                            } else {
                                Text("Open Fleet on the Mac that started this task to respond.")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        if !run.result.isEmpty {
                            Text((run.truncated ? "… " : "") + run.result).textSelection(.enabled)
                        }
                    } else { ProgressView("Loading timeline…") }
                }
                Section("Timeline") {
                    if model.timeline.historyLimited {
                        Text("Earlier entries are no longer retained on this Mac.").font(.footnote)
                    }
                    ForEach(model.timeline.entries) { e in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(e.title).font(.subheadline.bold())
                            if let result = e.result { Text((e.truncated == true ? "… " : "") + result).textSelection(.enabled) }
                            Text(Date(timeIntervalSince1970: e.at / 1000), style: .time)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Task timeline")
            .task(id: active) { await poll() }
            .refreshable { await model.refresh(client) }
        }
        .refreshable { await model.refresh(client) }
        .task(id: active) { await poll() }
        .sheet(item: $reviewing) { run in approvalSheet(run) }
        .onChange(of: active) { _, active in if !active { reviewing = nil } }
        .onChange(of: model.selection) { _, _ in reviewing = nil }
    }

    private func approvalSheet(_ run: FleetTask) -> some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(macName + " · " + run.workspaceName + " · " + run.id.prefix(8))
                        if let approval = run.approval {
                            Text(approval.tool + " · " + approval.target).font(.headline)
                            Text("Expires \(Date(timeIntervalSince1970: approval.expiresAt / 1000).formatted())")
                                .font(.caption)
                            Text("Review the complete tool input before allowing or denying this request.")
                            Text(approval.preview ?? "").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            if let message = model.decisionMessage { Text(message).foregroundStyle(.secondary) }
                            if !model.canDecide(run) && !model.deciding {
                                Text("This request changed, expired, or has already been answered. Close this preview and refresh the task.")
                            }
                            HStack {
                                Button("Deny", role: .destructive) { sendDecision(run, allow: false) }
                                    .disabled(!active || !model.canDecide(run, allow: false))
                                    .accessibilityIdentifier("fleet.deny")
                                Spacer()
                                Button("Allow this request") { sendDecision(run, allow: true) }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(!active || !model.canDecide(run, allow: true))
                                    .accessibilityIdentifier("fleet.allow")
                            }
                        }
                    }.padding()
                }
            }
            .navigationTitle("Review request")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { reviewing = nil } } }
        }
    }
    private func sendDecision(_ run: FleetTask, allow: Bool) {
        guard active else { return }
        Task {
            if await model.decide(client, run: run, allow: allow) { reviewing = nil }
            await model.refresh(client)
        }
    }

    private func poll() async {
        guard active else { return }
        while !Task.isCancelled {
            await model.refresh(client)
            try? await Task.sleep(for: .seconds(4))
        }
    }
}
