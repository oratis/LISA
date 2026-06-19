import SwiftUI

/// LISA's own fire-and-forget dispatches (the ledger), distinct from the
/// observed-agent roster (docs/IOS_COMPANION_PLAN.md §6.2): pid / task / alive,
/// from /api/dispatch/list, with a captured log tail per entry from
/// /api/dispatch/status. Reached from the Dispatch tab's toolbar.
struct DispatchLedgerView: View {
    @EnvironmentObject var app: AppState
    @State private var items: [DispatchView] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Group {
            if !loaded {
                ProgressView()
            } else if let error {
                ContentUnavailableView("Couldn't load", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if items.isEmpty {
                ContentUnavailableView("No dispatches", systemImage: "tray",
                                       description: Text("Lisa hasn't dispatched any agents recently."))
            } else {
                List(items) { d in
                    NavigationLink { DispatchDetailView(entry: d) } label: {
                        HStack(spacing: 10) {
                            Circle().fill(d.alive ? .blue : .gray).frame(width: 8, height: 8)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(d.task).font(.subheadline).lineLimit(1)
                                Text("\(d.agent) · pid \(d.pid)\(d.alive ? " · alive" : "")")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Dispatches")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do { items = try await app.client.dispatchList(); error = nil }
        catch { self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)" }
        loaded = true
    }
}

struct DispatchDetailView: View {
    @EnvironmentObject var app: AppState
    let entry: DispatchView
    @State private var tail = ""
    @State private var status: DispatchStatus?

    var body: some View {
        List {
            Section("Dispatch") {
                LabeledContent("Agent", value: entry.agent)
                LabeledContent("Task", value: entry.task)
                LabeledContent("pid", value: String(entry.pid))
                LabeledContent("Alive", value: (status?.alive ?? entry.alive) ? "yes" : "no")
                LabeledContent("cwd", value: entry.cwd)
            }
            Section("Log tail") {
                if tail.isEmpty {
                    Text(entry.hasLog ? "…" : "No log captured.").font(.caption).foregroundStyle(.secondary)
                } else {
                    ScrollView(.horizontal) {
                        Text(tail).font(.system(.caption2, design: .monospaced))
                    }
                }
            }
        }
        .navigationTitle(entry.agent)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        // status is gated by the control policy; tolerate a 403/404 (leave tail empty).
        if let s = try? await app.client.dispatchStatus(id: entry.id) {
            status = s
            tail = s.tail ?? ""
        }
    }
}
