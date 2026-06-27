import WidgetKit
import SwiftUI

/// Home-screen / Lock-screen glance at the roster: how many agents are active vs.
/// stuck (docs/IOS_COMPANION_PLAN.md §G5). It renders the last snapshot the app wrote
/// to the App Group — no network, no token in the extension. Freshness therefore
/// tracks the last time the app refreshed the roster; the app nudges the timeline via
/// `WidgetCenter.reloadAllTimelines()`, and we re-read on a fallback cadence too.
struct AgentCountEntry: TimelineEntry {
    let date: Date
    let snapshot: AgentSnapshot?
}

struct AgentCountProvider: TimelineProvider {
    func placeholder(in context: Context) -> AgentCountEntry {
        AgentCountEntry(date: Date(), snapshot: AgentSnapshot(working: 2, waiting: 1, error: 0, total: 3, updatedAt: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (AgentCountEntry) -> Void) {
        completion(AgentCountEntry(date: Date(), snapshot: SharedStore.readSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AgentCountEntry>) -> Void) {
        let entry = AgentCountEntry(date: Date(), snapshot: SharedStore.readSnapshot())
        let next = Date().addingTimeInterval(15 * 60)  // fallback re-read; app reloads sooner when it can
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

struct AgentCountWidgetView: View {
    var entry: AgentCountEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryInline:
            Text(inlineText)
        case .accessoryCircular:
            circular
        case .accessoryRectangular:
            rectangular
        default:
            if let snap = entry.snapshot, snap.updatedAt > .distantPast { populated(snap) }
            else { unconfigured }
        }
    }

    /// Round lock-screen / StandBy slot (C10): the most urgent number — stuck if
    /// any, else active.
    @ViewBuilder private var circular: some View {
        if let s = entry.snapshot, s.updatedAt > .distantPast {
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "cpu").font(.system(size: 10))
                    Text("\(s.stuck > 0 ? s.stuck : s.working)").font(.headline.bold())
                }
            }
        } else {
            Image(systemName: "cpu")
        }
    }

    /// A snapshot older than 10 min is shown dimmed rather than as confidently
    /// live (review B25); relative time (below) also conveys the age.
    private func isStale(_ snap: AgentSnapshot) -> Bool {
        entry.date.timeIntervalSince(snap.updatedAt) > 600
    }

    // Lock-screen accessory families: terse, no background (system styles them).
    private var inlineText: String {
        guard let s = entry.snapshot, s.updatedAt > .distantPast else { return "Lisa — open to pair" }
        return "▶ \(s.working) active · ⏸ \(s.stuck) stuck"
    }

    @ViewBuilder private var rectangular: some View {
        if let s = entry.snapshot, s.updatedAt > .distantPast {
            VStack(alignment: .leading, spacing: 2) {
                Label("Dispatch", systemImage: "cpu").font(.caption2.bold())
                Text("\(s.working) active · \(s.stuck) stuck").font(.caption)
                Text(summary(s)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        } else {
            Text("Open Lisa Pocket").font(.caption)
        }
    }

    @ViewBuilder
    private func populated(_ snap: AgentSnapshot) -> some View {
        VStack(alignment: .leading, spacing: family == .systemMedium ? 10 : 6) {
            HStack(spacing: 6) {
                Image(systemName: "cpu").font(.caption2)
                Text("Dispatch").font(.caption.bold())
                Spacer()
                Text(snap.updatedAt, style: .relative)               // B24 — "3 min" reads as freshness
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }
            HStack(spacing: family == .systemMedium ? 20 : 12) {
                stat(snap.working, "active", GlanceColors.working)
                stat(snap.stuck, "stuck", snap.stuck > 0 ? (snap.error > 0 ? GlanceColors.error : GlanceColors.waiting) : .secondary)
                if family == .systemMedium {
                    stat(snap.total, "total", .secondary)
                }
            }
            if family == .systemMedium {
                Text(summary(snap)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .opacity(isStale(snap) ? 0.55 : 1)                           // B25 — dim a stale snapshot
    }

    private func stat(_ value: Int, _ label: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(value)").font(.system(.title, design: .rounded).weight(.bold)).foregroundStyle(color)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func summary(_ snap: AgentSnapshot) -> String {
        if snap.error > 0 { return "\(snap.error) errored · \(snap.waiting) waiting" }
        if snap.waiting > 0 { return "\(snap.waiting) waiting on you" }
        if snap.working > 0 { return "all running smoothly" }
        return "nothing running"
    }

    private var unconfigured: some View {
        VStack(spacing: 4) {
            Image(systemName: "wifi.slash").foregroundStyle(.secondary)
            Text("Open Lisa Pocket").font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct AgentCountWidget: Widget {
    let kind = "AgentCountWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: AgentCountProvider()) { entry in
            AgentCountWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: "lisapocket://roster"))  // tap → open the Dispatch tab
        }
        .configurationDisplayName("Agent activity")
        .description("Active and stuck agents on your Mac.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
