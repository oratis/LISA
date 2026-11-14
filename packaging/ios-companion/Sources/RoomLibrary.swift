import SwiftUI

struct RoomKnowledgeItem: Decodable, Identifiable {
    let layer: String
    let slug: String
    let title: String
    let excerpt: String?
    let body: String?
    var id: String { layer + "/" + slug }
}

struct RoomDream: Decodable, Identifiable {
    let id: String
    let trigger: String
    let summary: String
    let windowEnd: String
}

struct RoomReflectionLog: Decodable {
    struct Reflection: Decodable, Identifiable {
        let sessionId: String
        let summary: String
        let at: String
        var id: String { sessionId }
    }
    struct Run: Decodable {
        let kind: String
        let at: String
        let outcome: String
        let note: String?
    }
    let reflections: [Reflection]
    let runs: [Run]
}

struct RoomKnowledgeView: View {
    @EnvironmentObject private var app: AppState
    @State private var query = ""
    @State private var entries: [RoomKnowledgeItem]?
    @State private var error: String?
    @State private var retry = 0

    var body: some View {
        Group {
            if !app.config.isConfigured {
                RoomConnectionPrompt()
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't load knowledge", systemImage: "book.closed")
                } description: { Text(error) } actions: { Button("Try again") { retry += 1 } }
            } else if let entries, entries.isEmpty {
                if query.isEmpty {
                    ContentUnavailableView("Your library is empty", systemImage: "books.vertical",
                                           description: Text("Save a source with Lisa to find it here."))
                } else { ContentUnavailableView.search(text: query) }
            } else if let entries {
                List(entries) { item in
                    NavigationLink {
                        AsyncContent(load: { try await app.client.knowledgeEntry(item) }) { entry in
                            if let entry {
                                ScrollView {
                                    VStack(alignment: .leading, spacing: 12) {
                                        Text(entry.title).font(Theme.title(.largeTitle)).accessibilityAddTraits(.isHeader)
                                        Divider().padding(.vertical, 4)
                                        Text(entry.body ?? "").font(.body).lineSpacing(5).textSelection(.enabled)
                                    }.frame(maxWidth: Theme.readingWidth, alignment: .leading)
                                    .padding(Theme.Space.l).frame(maxWidth: .infinity)
                                }
                            } else { ContentUnavailableView("Entry unavailable", systemImage: "book.closed") }
                        }.consoleBackground().navigationTitle("Entry").navigationBarTitleDisplayMode(.inline)
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "doc.text").foregroundStyle(Theme.accent)
                                .frame(width: 40, height: 46).background(Theme.sage, in: RoundedRectangle(cornerRadius: 10))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title).font(.headline).foregroundStyle(Theme.text)
                                if let excerpt = item.excerpt { Text(excerpt).font(.subheadline).foregroundStyle(Theme.secondary).lineLimit(2) }
                            }
                        }.padding(.vertical, 5)
                    }
                }
            } else { ProgressView() }
        }
        .consoleBackground()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search knowledge")
        .navigationTitle("Knowledge")
        .task(id: Search(query: query, retry: retry)) {
            // Keep the current results and search field in place during the debounce.
            error = nil
            guard app.config.isConfigured else { return }
            do {
                if !query.isEmpty { try await Task.sleep(for: .milliseconds(280)) }
                let found = try await app.client.knowledge(query: query)
                try Task.checkCancellation()
                entries = found
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }
    private struct Search: Equatable { let query: String; let retry: Int }
}

struct RoomReveView: View {
    @EnvironmentObject private var app: AppState
    let note: String?
    @State private var dreams: [RoomDream]?
    @State private var dreamError: String?
    @State private var log: RoomReflectionLog?
    @State private var failure: String?

    var body: some View {
        Group {
            if !app.config.isConfigured { RoomConnectionPrompt() }
            else {
                List {
                    if let note, !note.isEmpty {
                        Section("A note from Lisa") {
                            Text(note)
                            Button("Discuss this note") { app.compose(note) }
                        }
                    }
                    Section("Dream journal") {
                        if let dreams {
                            if dreams.isEmpty { Text("No recorded dreams.").foregroundStyle(.secondary) }
                            ForEach(dreams) { dream in
                                DisclosureGroup {
                                    Text(dream.summary).textSelection(.enabled)
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(dream.trigger.capitalized)
                                        Text(Self.dateLabel(dream.windowEnd)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        } else if let dreamError {
                            Text(dreamError).foregroundStyle(.secondary)
                        } else { ProgressView() }
                    }
                    if let log {
                        Section("Reflections") {
                            if log.reflections.isEmpty { Text("No reflections this week.").foregroundStyle(.secondary) }
                            ForEach(log.reflections) { item in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.summary).font(.body).lineSpacing(4).textSelection(.enabled)
                                    Text(Self.dateLabel(item.at)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        Section("Recent runs") {
                            if log.runs.isEmpty { Text("No runs this week.").foregroundStyle(.secondary) }
                            ForEach(Array(log.runs.enumerated()), id: \.offset) { _, run in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(run.kind.capitalized + " · " + run.outcome).font(.headline)
                                    if let note = run.note, !note.isEmpty { Text(note) }
                                    Text(Self.dateLabel(run.at)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    } else if let failure {
                        Text(failure).foregroundStyle(.secondary)
                        Button("Try again") { Task { await load() } }
                    } else { ProgressView() }
                }.refreshable { await load() }.task { await load() }
            }
        }.consoleBackground().navigationTitle("Rêve")
    }

    private static func dateLabel(_ string: String) -> String {
        let style = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return (try? style.parse(string))?.formatted(date: .abbreviated, time: .shortened) ?? string
    }
    @MainActor private func load() async {
        let client = app.client
        async let journal = client.roomDreams()
        async let overview = client.reflections()
        do {
            let value = try await journal
            try Task.checkCancellation()
            dreams = value; dreamError = nil
        } catch { if !Task.isCancelled { dreamError = error.localizedDescription; dreams = nil } }
        do {
            let value = try await overview
            try Task.checkCancellation()
            log = value; failure = nil
        } catch { if !Task.isCancelled { failure = error.localizedDescription; log = nil } }
    }
}

struct RoomConnectionPrompt: View {
    @EnvironmentObject private var app: AppState
    var body: some View {
        ContentUnavailableView {
            Label("Connect to Lisa", systemImage: "link")
        } description: { Text("Sign in to LISA Cloud or connect your Mac.") }
        actions: { Button("Get started") { app.presentOnboarding() } }
    }
}
