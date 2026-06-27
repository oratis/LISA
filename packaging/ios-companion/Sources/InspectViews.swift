import SwiftUI

/// Read-only "speed views" of Lisa's interior (docs/IOS_COMPANION_PLAN.md §G6,
/// Appendix B): Soul, Memory, Skills, Tools. All GET-only; reached from Settings.

/// A tiny loader that runs an async fetch on appear and renders loading / error /
/// content, so each inspection view stays a one-liner over its data.
struct AsyncContent<T, Content: View>: View {
    let load: () async throws -> T
    @ViewBuilder let content: (T) -> Content

    @State private var value: T?
    @State private var error: String?

    var body: some View {
        Group {
            if let value {
                content(value)
            } else if let error {
                ContentUnavailableView("Couldn't load", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .task {
            do { value = try await load(); error = nil }
            catch { self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)" }
        }
    }
}

struct SoulView: View {
    @EnvironmentObject var app: AppState
    var body: some View {
        AsyncContent(load: { try await app.client.soul() }) { resp in
            if !resp.born || resp.summary == nil {
                ContentUnavailableView("Not born yet", systemImage: "moon.stars",
                                       description: Text("Lisa hasn't run her birth ritual."))
            } else if let s = resp.summary {
                List {
                    if let n = s.name, !n.isEmpty { Section("Name") { Text(n) } }
                    soulText("Identity", s.identity)
                    soulText("Purpose", s.purpose)
                    soulText("Constitution", s.constitution)
                    if let emo = s.emotions?.values, !emo.isEmpty {
                        Section("Mood") {
                            ForEach(emo.sorted(by: { $0.value > $1.value }), id: \.key) { k, v in
                                HStack {
                                    Text(k).font(.subheadline)
                                    Spacer()
                                    ProgressView(value: max(0, min(1, v))).frame(width: 120)
                                }
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(k)
                                .accessibilityValue("\(Int((max(0, min(1, v))) * 100)) percent")
                            }
                        }
                    }
                    soulItems("Values", s.values)
                    soulItems("Opinions", s.opinions)
                    soulItems("Desires", s.desires)
                    if let t = s.tampered, !t.isEmpty {
                        Section("⚠ Tampered files") { ForEach(t, id: \.self) { Text($0).font(.caption.monospaced()) } }
                    }
                }
            }
        }
        .navigationTitle("Soul")
    }

    @ViewBuilder private func soulText(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty { Section(title) { Text(value).font(.callout) } }
    }
    @ViewBuilder private func soulItems(_ title: String, _ items: [SoulItem]?) -> some View {
        if let items, !items.isEmpty {
            Section("\(title) (\(items.count))") {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in Text(it.label).font(.callout) }
            }
        }
    }
}

struct MemoryView: View {
    @EnvironmentObject var app: AppState
    var body: some View {
        AsyncContent(load: { try await app.client.memory() }) { mem in
            List {
                if !mem.user.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section("Who you are (user)") { Text(mem.user).font(.system(.callout, design: .monospaced)) }
                }
                if !mem.memory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section("Memory") { Text(mem.memory).font(.system(.callout, design: .monospaced)) }
                }
            }
        }
        .navigationTitle("Memory")
    }
}

struct DevicesView: View {
    @EnvironmentObject var app: AppState
    var body: some View {
        AsyncContent(load: { try await app.client.devices() }) { devices in
            List {
                Section {
                    if devices.isEmpty {
                        Text("No paired devices.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(devices) { d in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(d.name).font(.headline)
                                Text(d.platform + (d.lastSeenAt.map { " · seen \(Self.rel($0))" } ?? ""))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: {
                    Text("Each device has its own revocable token. Revoke one on the Mac (localhost only).")
                }
            }
        }
        .navigationTitle("Paired devices")
    }

    /// Relative time from an epoch-ms timestamp.
    static func rel(_ ms: Double) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
    }
}

struct NamedListView: View {
    let title: String
    let load: () async throws -> [NamedItem]
    var body: some View {
        AsyncContent(load: load) { items in
            if items.isEmpty {
                ContentUnavailableView("None", systemImage: "tray", description: Text("Nothing here."))
            } else {
                List(items) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.name).font(.headline)
                        if let d = item.description, !d.isEmpty {
                            Text(d).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle(title)
    }
}
