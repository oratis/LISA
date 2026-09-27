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
                    ContentUnavailableView {
                        Label("Your personal assistant", systemImage: "sparkles")
                    } description: {
                        Text("Plan your day, write a first draft, and work through ideas with Lisa. Sign in to the cloud or connect your Mac.")
                    } actions: {
                        Button("Get started") { app.presentOnboarding() }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    ScrollView {
                        VStack(spacing: Theme.Space.m) {
                            connectionCard
                            assistantStarters
                            moodHero
                            if let d = ping?.current_desire, !d.isEmpty { wantsCard(d) }
                            if app.connectionMode == .mac { agentsCard }
                            if mailAccounts > 0, let m = mailDigest { mailCard(m) }
                            if app.connectionMode == .mac { recapCard }
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

    private var connectionCard: some View {
        HStack {
            Label(app.connectionMode.label, systemImage: app.connectionMode == .cloud ? "cloud" : "desktopcomputer")
                .font(.subheadline.weight(.semibold))
            Spacer()
            Button("Manage") { app.selectedTab = 3 }
        }.consoleCard()
    }

    private var assistantStarters: some View {
        cardShell("What can I help with?", "sparkles") {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(AssistantStarter.all) { starter in
                    Button { app.compose(starter.prompt) } label: {
                        Label(starter.title, systemImage: starter.icon)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.accent)
                    .accessibilityHint("Opens an editable message. Nothing is sent yet.")
                }
            }
        }
    }

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
        .accessibilityHint("Opens the Agents tab")
    }

    private func mailCard(_ m: MailDigest) -> some View {
        cardShell("Mail · \(m.date)", "envelope") {
            VStack(alignment: .leading, spacing: 6) {
                Text(m.summary).font(.callout)
                ForEach(m.needsYou.prefix(3)) { i in
                    HStack(alignment: .top, spacing: 6) {
                        // Word + glyph, not colour alone (D1) — "‼" red vs "!"
                        // amber is invisible to a colour-blind reader.
                        Text(i.importance >= 3 ? "‼ Urgent" : "! Important")
                            .font(.caption2.bold())
                            .foregroundStyle(i.importance >= 3 ? Theme.danger : Theme.waiting)
                            .fixedSize(horizontal: true, vertical: false)
                        Text(i.subject.isEmpty ? "(no subject)" : i.subject).font(.caption).lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
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
        // The portrait IS the mood readout — an unlabeled AsyncImage would drop
        // it entirely from the combined hero element (D6).
        .accessibilityLabel("Lisa's portrait, \(ping?.mood.isEmpty == false ? ping!.mood.replacingOccurrences(of: "-", with: " ") : "neutral")")
    }

    private var moodLine: String {
        guard let m = ping?.mood, !m.isEmpty else { return "Lisa" }
        return "She's \(m.replacingOccurrences(of: "-", with: " "))"
    }

    private func load() async {
        guard app.config.isConfigured else { return }
        let expected = app.config
        let client = app.client
        let p = try? await client.islandPing()
        guard !Task.isCancelled, app.config == expected else { return }
        ping = p
        error = p == nil ? "Couldn't reach Lisa. Pull to retry or check Settings." : nil
        guard app.connectionMode == .mac else { return }
        async let recapResult = client.recap(sinceMinutes: window)
        async let advisorResult = client.advisorLatest()
        async let mailDigestResult = client.mailDigest()
        async let mailAccountsResult = client.mailAccounts()
        async let sessionsResult = client.sessions()
        let values = await (try? recapResult, try? advisorResult, try? mailDigestResult,
                            try? mailAccountsResult, try? sessionsResult)
        guard !Task.isCancelled, app.config == expected else { return }
        recap = values.0?.text ?? ""
        suggestions = values.1?.suggestions ?? []
        mailDigest = values.2
        mailAccounts = values.3?.accounts.count ?? 0
        counts = rosterCounts(values.4 ?? [])
    }

    private func dismiss(_ s: AdvisorSuggestion) {
        suggestions.removeAll { $0.id == s.id }
        Task { try? await app.client.advisorDismiss(id: s.id, category: s.category) }
    }
}

private struct HomeLoadKey: Equatable { let window: Int; let configured: Bool }
