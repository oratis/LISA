import SwiftUI

/// Reve — Lisa's reflective surface (docs/IOS_COMPANION_PLAN.md Appendix B): a
/// "while you were away" note + current desire, a recap of recent agent activity
/// over a chosen window, and advisor suggestions (dismissable — feeds the
/// server's "learn to shut up" loop).
struct ReveView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.scenePhase) private var scenePhase

    @State private var ping: IslandPing?
    @State private var recap: String = ""
    @State private var suggestions: [AdvisorSuggestion] = []
    @State private var window = 120          // minutes
    @State private var error: String?
    @State private var loading = false
    @State private var mailDigest: MailDigest?
    @State private var mailAccounts = 0

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

                        if mailAccounts > 0, let m = mailDigest {
                            Section("📬 Mail · \(m.date)") {
                                Text(m.summary).font(.callout)
                                ForEach(m.needsYou.prefix(5)) { i in
                                    HStack(alignment: .top, spacing: 6) {
                                        Text(i.importance >= 3 ? "‼" : "!")
                                            .font(.caption.bold())
                                            .foregroundStyle(i.importance >= 3 ? .red : .orange)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(i.subject.isEmpty ? "(no subject)" : i.subject).font(.callout).lineLimit(1)
                                            Text(i.reason).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                        }
                                    }
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
            .consoleBackground()
            .navigationTitle("Reve")
            .refreshable { await load() }
            .task(id: ReveLoadKey(window: window, configured: app.config.isConfigured)) { await load() }
            .onChange(of: scenePhase) { _, p in if p == .active { Task { await load() } } }
        }
    }

    private func load() async {
        guard app.config.isConfigured else { return }
        loading = true
        defer { loading = false }
        async let pingResult = app.client.islandPing()
        async let recapResult = app.client.recap(sinceMinutes: window)
        async let advisorResult = app.client.advisorLatest()
        async let mailDigestResult = app.client.mailDigest()
        async let mailAccountsResult = app.client.mailAccounts()
        ping = try? await pingResult
        recap = (try? await recapResult)?.text ?? ""
        suggestions = (try? await advisorResult)?.suggestions ?? []
        mailDigest = try? await mailDigestResult
        mailAccounts = (try? await mailAccountsResult)?.accounts.count ?? 0
        error = nil
    }

    private func dismiss(_ s: AdvisorSuggestion) {
        suggestions.removeAll { $0.id == s.id }
        Task { try? await app.client.advisorDismiss(id: s.id, category: s.category) }
    }
}

/// Re-run the loader when the window changes or pairing flips on.
private struct ReveLoadKey: Equatable { let window: Int; let configured: Bool }
