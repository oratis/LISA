import Foundation

/// A tiny, low-sensitivity snapshot of the roster — agent *counts* only, never any
/// session content — shared from the app to the home-screen Widget across an App
/// Group. The auth token never leaves the Keychain: the app makes the authenticated
/// fetch and writes just these numbers, consistent with the metadata-only privacy
/// contract (docs/IOS_COMPANION_PLAN.md §5.5 / §7). Lives in Shared/ so both the app
/// (writer) and the widget extension (reader) compile it; it deliberately has no
/// `AgentSession` dependency, since that type isn't in the widget target.
struct AgentSnapshot: Codable, Equatable {
    var working: Int   // actively running
    var waiting: Int   // waiting on input or a pending permission — i.e. needs you
    var error: Int     // errored out
    var total: Int     // all roster rows, including idle/done
    var updatedAt: Date

    static let empty = AgentSnapshot(working: 0, waiting: 0, error: 0, total: 0, updatedAt: .distantPast)

    /// "Stuck" = needs your attention: waiting on input/permission, or errored.
    var stuck: Int { waiting + error }
}

/// The App Group-backed store the snapshot travels through. The group id must match
/// the `com.apple.security.application-groups` entitlement on *both* targets (set in
/// project.yml). Reads/writes degrade to no-ops if the group is unavailable (e.g. an
/// unsigned build with no group container), so callers never have to special-case it.
enum SharedStore {
    static let appGroup = "group.ai.meetlisa.pocket"
    private static let snapshotKey = "roster.snapshot"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func writeSnapshot(_ snapshot: AgentSnapshot) {
        guard let defaults, let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: snapshotKey)
    }

    static func readSnapshot() -> AgentSnapshot? {
        guard let data = defaults?.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(AgentSnapshot.self, from: data) else { return nil }
        return snapshot
    }
}
