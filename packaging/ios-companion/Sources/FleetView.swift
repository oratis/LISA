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
    private var active: Bool { scenePhase == .active && !app.locked }

    var body: some View {
        List {
            Section {
                Text("Current Mac: \(macName)")
                Text("Read-only tasks shared with this Pocket. Approvals are handled on the Mac that started the task.")
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
                        Text(run.state).font(.subheadline)
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
                    Text("\(macName) · Read only")
                    if let message = model.message { Text(message).font(.footnote) }
                    if let run = model.timeline.run {
                        Text(run.workspaceName + " · " + run.state)
                        Text("Updated \(Date(timeIntervalSince1970: run.updatedAt / 1000).formatted())")
                            .font(.caption).foregroundStyle(.secondary)
                        if let approval = run.approval {
                            Text("Waiting for approval: \(approval.tool) \(approval.target)")
                            Text("Open Fleet on the Mac that started this task to respond.")
                                .font(.footnote).foregroundStyle(.secondary)
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
    }

    private func poll() async {
        guard active else { return }
        while !Task.isCancelled {
            await model.refresh(client)
            try? await Task.sleep(for: .seconds(4))
        }
    }
}
