import ActivityKit
import Foundation

/// The Live Activity payload for a pinned agent. Shared by the app (which starts /
/// updates the activity) and the widget extension (which renders it on the Lock
/// Screen + Dynamic Island).
struct AgentActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var state: String      // working | waiting | error | done | …
        var detail: String     // stateReason / pending permission / last tool
        var turns: Int
    }

    var agent: String
    var project: String
    var sessionId: String
}
