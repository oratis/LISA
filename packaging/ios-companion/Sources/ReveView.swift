import SwiftUI

/// Reve — Lisa's reflective surface (docs/IOS_COMPANION_PLAN.md Appendix B): a
/// "while you were away" note + current desire, a recap of recent agent activity
/// over a chosen window, and advisor suggestions (dismissable — feeds the
/// server's "learn to shut up" loop).
struct ReveView: View {
    @EnvironmentObject var app: AppState

    @State private var ping: IslandPing?
    @State private var recap: String = ""
    @State private var suggestions: [AdvisorSuggestion] = []
    @State private var window = 120          // minutes
    @State private var error: String?
    @State private var loading = false

    private let windows: [(String, Int)] = [("2h", 120), ("8h", 480), ("24h", 1440)]

    var body: some View {
        NavigationStack {
            Group {
                if !app.config.isConfigured {
                    ContentUnavailableView("Not paired", systemImage: "wifi.slash",
                                           description: Text("Add your Mac in Settings."))
                } else {
                    List {
                        if let p = ping {
                            if let note = p.last_idle_message_text, !note.isEmpty {
                                Section("While you were away") { Text(note).font(.callout) }
                            }
                            if let desire = p.current_desire, !desire.isEmpty {
                                Section("Current desire") {
                                    Label(desire, systemImage: "scope").font(.callout)
                                }
                            }
                        }

                        Section {
                            Picker("Window", selection: $window) {
                                ForEach(windows, id: \.1) { Text($0.0).tag($0.1) }
                            }
                            .pickerStyle(.segmented)
                            if recap.isEmpty {
                                Text(loading ? "…" : "No agent activity in this window.")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else {
                                Text(recap).font(.system(.callout, design: .monospaced))
                            }
                        } header: { Text("Recap") }

                        if !suggestions.isEmpty {
                            Section("Suggestions") {
                                ForEach(suggestions) { s in
                                    VStack(alignment: .leading, spacing: 4) {
                                        if let c = s.category {
                                            Text(c.uppercased()).font(.caption2).foregroundStyle(.secondary)
                                        }
                                        Text(s.text).font(.callout)
                                        Button("Dismiss", role: .destructive) { dismiss(s) }
                                            .font(.caption).buttonStyle(.borderless)
                                    }
                                }
                            }
                        }

                        if let error { Section { Text(error).font(.caption).foregroundStyle(.secondary) } }
                    }
                }
            }
            .navigationTitle("Reve")
            .refreshable { await load() }
            .task(id: ReveLoadKey(window: window, configured: app.config.isConfigured)) { await load() }
        }
    }

    private func load() async {
        guard app.config.isConfigured else { return }
        loading = true
        defer { loading = false }
        async let pingResult = app.client.islandPing()
        async let recapResult = app.client.recap(sinceMinutes: window)
        async let advisorResult = app.client.advisorLatest()
        ping = try? await pingResult
        recap = (try? await recapResult)?.text ?? ""
        suggestions = (try? await advisorResult)?.suggestions ?? []
        error = nil
    }

    private func dismiss(_ s: AdvisorSuggestion) {
        suggestions.removeAll { $0.id == s.id }
        Task { try? await app.client.advisorDismiss(id: s.id, category: s.category) }
    }
}

/// Re-run the loader when the window changes or pairing flips on.
private struct ReveLoadKey: Equatable { let window: Int; let configured: Bool }
