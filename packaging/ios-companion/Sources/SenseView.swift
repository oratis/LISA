import SwiftUI

/// Sense — ambient-signal consent + recent events (docs/IOS_COMPANION_PLAN.md §G6,
/// §7.2). Deliberately *revoke-only* from a phone: tightening consent is always
/// safe, but granting a sensitive signal remotely would widen the surface, which
/// the privacy floor says stays a Mac action. So we show state + let you revoke,
/// and point grants at the Mac.
struct SenseView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.scenePhase) private var scenePhase

    @State private var grants: [ConsentRow] = []
    @State private var events: [SenseEvent] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if !app.config.isConfigured {
                    ContentUnavailableView("Not paired", systemImage: "wifi.slash",
                                           description: Text("Add your Mac in Settings."))
                } else {
                    List {
                        Section {
                            ForEach(grants) { row in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.signal).font(.headline)
                                        if let d = row.description, !d.isEmpty {
                                            Text(d).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if row.granted {
                                        Button("Revoke", role: .destructive) { revoke(row.signal) }
                                            .font(.caption).buttonStyle(.borderless)
                                    } else {
                                        Text("off").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            if grants.contains(where: { $0.granted }) {
                                Button("Revoke all", role: .destructive) { revokeAll() }
                            }
                        } header: { Text("Consent") } footer: {
                            Text("Tightening is safe from anywhere. Grant new signals on the Mac (privacy floor).")
                        }

                        Section("Recent events") {
                            if events.isEmpty {
                                Text("Nothing captured.").font(.caption).foregroundStyle(.secondary)
                            } else {
                                ForEach(events) { e in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(e.summary).font(.callout).lineLimit(2)
                                        Text("\(e.signal) · \(e.kind)\(e.app.map { " · \($0)" } ?? "")")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }

                        if let error { Section { Text(error).font(.caption).foregroundStyle(.secondary) } }
                    }
                }
            }
            .consoleBackground()
            .navigationTitle("Sense")
            .refreshable { await load() }
            .task(id: app.config) { await load() }
            .onChange(of: scenePhase) { _, p in if p == .active { Task { await load() } } }
        }
    }

    private func load() async {
        guard app.config.isConfigured else { return }
        async let g = app.client.consent()
        async let e = app.client.senseRecent()
        grants = (try? await g) ?? []
        events = (try? await e) ?? []
        error = grants.isEmpty && events.isEmpty ? "Couldn't reach Lisa." : nil
    }

    private func revoke(_ signal: String) {
        Task { try? await app.client.consentRevoke(signal: signal); await load() }
    }
    private func revokeAll() {
        Task { try? await app.client.consentRevokeAll(); await load() }
    }
}
