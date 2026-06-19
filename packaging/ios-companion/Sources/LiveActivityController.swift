import ActivityKit
import Foundation

/// Starts the Live Activity for a pinned agent. (Updating it as state changes is a
/// follow-up — ideally driven by APNs Live Activity remote updates so it stays
/// fresh while the app is backgrounded.)
enum LiveActivityController {
    @discardableResult
    static func start(for session: AgentSession) -> String? {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
        let attributes = AgentActivityAttributes(
            agent: session.agent,
            project: session.project,
            sessionId: session.sessionId
        )
        let state = AgentActivityAttributes.ContentState(
            state: session.state,
            detail: detail(for: session),
            turns: session.activity?.turnCount ?? 0
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil)
            )
            return activity.id
        } catch {
            return nil
        }
    }

    static func detail(for s: AgentSession) -> String {
        if let pending = s.activity?.pendingPermission { return "⚠ \(pending)" }
        if !s.stateReason.isEmpty { return s.stateReason }
        return s.activity?.lastTools?.last ?? s.state
    }
}
