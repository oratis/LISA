import ActivityKit
import Foundation

/// Starts the Live Activity for a pinned agent, requesting a push token so the Mac
/// can refresh it remotely (APNs `liveactivity`) while the app is backgrounded —
/// the backend half is in src/web/push.ts (sendLiveActivityUpdate). Live remote
/// updates still need an Apple push key; without one the activity is local-only.
enum LiveActivityController {
    @discardableResult
    static func start(for session: AgentSession, client: LisaClient? = nil) -> String? {
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
                content: .init(state: state, staleDate: nil),
                pushType: .token
            )
            // Forward the activity's push token so the Mac can update it remotely.
            if let client {
                Task {
                    for await tokenData in activity.pushTokenUpdates {
                        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                        try? await client.registerLiveActivity(sessionId: session.sessionId, token: hex)
                    }
                }
            }
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
