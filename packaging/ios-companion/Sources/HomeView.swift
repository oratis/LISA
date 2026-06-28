import SwiftUI

/// Home — a glanceable dashboard of Lisa (redesign direction B): her mood + what
/// she did while you were away, what she's wanting, the agents at a glance, recent
/// activity, advisor tips, and a way into her mind (Soul/Memory/Skills/Tools).
/// Replaces the old List-dump 'Lisa' tab with designed, hierarchical cards.
struct HomeView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.scenePhase) private var scenePhase

    @State private var ping: IslandPing?
    @State private var recap = ""
    @State private var suggestions: [AdvisorSuggestion] = []
    @State private var counts = AgentSnapshot.empty
    @State private var window = 120
    @State private var error: String?
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
                    ScrollView {
                        VStack(spacing: Theme.Space.m) {
                            moodHero
                            if let d = ping?.current_desire, !d.isEmpty { wantsCard(d) }
                            agentsCard
                            if mailAccounts > 0, let m = mailDigest { mailCard(m) }
                            recapCard
                            if !suggestions.isEmpty { suggestionsCard }
                            mindCard
                            if let error {
                                Text(error).font(.caption).foregroundStyle(Theme.tertiary)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .padding()
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bgDeep.ignoresSafeArea())
            .navigationTitle("Lisa")
            .refreshable { await load() }
            .task(id: HomeLoadKey(window: window, configured: app.config.isConfigured)) { await load() }
            .onChange(of: scenePhase) { _, p in if p == .active { Task { await load() } } }
        }
    }

    // ── cards ──────────────────────────────────────────────────────────

    private var moodHero: some View {
        HStack(spacing: Theme.Space.m) {
            portrait(72)
            VStack(alignment: .leading, spacing: 4) {
                Text(moodLine).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                if let note = ping?.last_idle_message_text, !note.isEmpty {
                    Text(note).font(.subheadline).foregroundStyle(Theme.secondary).lineLimit(3)
                } else {
                    Text("Born \(ping.map { _ in "and growing" } ?? "—") · tap her mind below")
                        .font(.subheadline).foregroundStyle(Theme.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .consoleCard()
        .accessibilityElement(children: .combine)
    }

    private func wantsCard(_ desire: String) -> some View {
        cardShell("She's wanting", "scope") {
            Text(desire).font(.callout).foregroundStyle(Theme.text)
        }
    }

    private var agentsCard: some View {
        Button { app.selectedTab = 2 } label: {
            HStack(spacing: Theme.Space.m) {
                Image(systemName: "cpu").font(.title3).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("AGENTS").font(.caption2).foregroundStyle(Theme.tertiary)
                    HStack(spacing: 12) {
                        Text("\(counts.working) active").foregroundStyle(Theme.working)
                        if counts.stuck > 0 { Text("\(counts.stuck) needs you").foregroundStyle(Theme.waiting) }
                        else { Text("all calm").foregroundStyle(Theme.secondary) }
                    }.font(.subheadline.weight(.medium))
                }
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(Theme.tertiary)
            }
            .consoleCard()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Agents: \(counts.working) active, \(counts.stuck) need you")
    }

    private func mailCard(_ m: MailDigest) -> some View {
        cardShell("Mail · \(m.date)", "envelope") {
            VStack(alignment: .leading, spacing: 6) {
                Text(m.summary).font(.callout)
                ForEach(m.needsYou.prefix(3)) { i in
                    HStack(alignment: .top, spacing: 6) {
                        Text(i.importance >= 3 ? "‼" : "!")
                            .font(.caption.bold()).foregroundStyle(i.importance >= 3 ? Theme.danger : Theme.waiting)
                            .accessibilityLabel(i.importance >= 3 ? "urgent" : "important")
                        Text(i.subject.isEmpty ? "(no subject)" : i.subject).font(.caption).lineLimit(1)
                    }
                }
            }
        }
    }

    private var recapCard: some View {
        cardShell("Recent activity", "clock.arrow.circlepath") {
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                Picker("Window", selection: $window) {
                    ForEach(windows, id: \.1) { Text($0.0).tag($0.1) }
                }.pickerStyle(.segmented)
                if recap.isEmpty {
                    Text("Nothing in this window.").font(.caption).foregroundStyle(Theme.secondary)
                } else {
                    CodeBlock(text: recap, maxHeight: 200)
                }
            }
        }
    }

    private var suggestionsCard: some View {
        cardShell("Lisa suggests", "lightbulb") {
            VStack(alignment: .leading, spacing: Theme.Space.m) {
                ForEach(suggestions) { s in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.text).font(.callout)
                        Button("Dismiss", role: .destructive) { dismiss(s) }
                            .font(.caption).buttonStyle(.borderless)
                    }
                }
            }
        }
    }

    private var mindCard: some View {
        cardShell("Lisa's mind", "brain") {
            VStack(spacing: 0) {
                mindRow("Soul", "sparkles") { SoulView() }
                Divider().overlay(Theme.border)
                mindRow("Memory", "brain") { MemoryView() }
                Divider().overlay(Theme.border)
                mindRow("Skills", "wand.and.stars") { NamedListView(title: "Skills", load: { try await app.client.skills() }) }
                Divider().overlay(Theme.border)
                mindRow("Tools", "wrench.and.screwdriver") { NamedListView(title: "Tools", load: { try await app.client.tools() }) }
            }
        }
    }

    private func mindRow<D: View>(_ title: String, _ icon: String, @ViewBuilder dest: @escaping () -> D) -> some View {
        NavigationLink { dest() } label: {
            HStack {
                Label(title, systemImage: icon).foregroundStyle(Theme.text)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.tertiary)
            }
            .padding(.vertical, 10)
        }
    }

    // ── shared card chrome ──
    private func cardShell<C: View>(_ title: String, _ icon: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleCard()
    }

    private func portrait(_ size: CGFloat) -> some View {
        let slug = (ping?.mood.isEmpty == false ? ping!.mood : "neutral")
        let safe = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
        return Group {
            if let url = app.client.assetURL("/assets/lisa/\(safe).png") {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFit()
                    case .empty: ProgressView()
                    default: Image(systemName: "person.crop.circle.fill").resizable().scaledToFit().foregroundStyle(Theme.secondary)
                    }
                }
            } else {
                Image(systemName: "person.crop.circle.fill").resizable().scaledToFit().foregroundStyle(Theme.secondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var moodLine: String {
        guard let m = ping?.mood, !m.isEmpty else { return "Lisa" }
        return "She's \(m.replacingOccurrences(of: "-", with: " "))"
    }

    private func load() async {
        guard app.config.isConfigured else { return }
        async let pingResult = app.client.islandPing()
        async let recapResult = app.client.recap(sinceMinutes: window)
        async let advisorResult = app.client.advisorLatest()
        async let mailDigestResult = app.client.mailDigest()
        async let mailAccountsResult = app.client.mailAccounts()
        async let sessionsResult = app.client.sessions()
        let p = try? await pingResult
        ping = p
        recap = (try? await recapResult)?.text ?? ""
        suggestions = (try? await advisorResult)?.suggestions ?? []
        mailDigest = try? await mailDigestResult
        mailAccounts = (try? await mailAccountsResult)?.accounts.count ?? 0
        counts = rosterCounts((try? await sessionsResult) ?? [])
        error = p == nil ? "Couldn't reach Lisa." : nil
    }

    private func dismiss(_ s: AdvisorSuggestion) {
        suggestions.removeAll { $0.id == s.id }
        Task { try? await app.client.advisorDismiss(id: s.id, category: s.category) }
    }
}

private struct HomeLoadKey: Equatable { let window: Int; let configured: Bool }
