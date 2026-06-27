import ActivityKit
import Foundation

/// Starts the Live Activity for a pinned agent, requesting a push token so the Mac
/// can refresh it remotely (APNs `liveactivity`) while the app is backgrounded —
/// the backend half is in src/web/push.ts (sendLiveActivityUpdate). Live remote
/// updates still need an Apple push key; without one the activity is local-only.
@MainActor
enum LiveActivityController {
    /// Pinned activities keyed by sessionId, so the app can `update`/`end` them
    /// locally. Previously it only ever called `.request` — so a pinned activity
    /// froze at its starting state forever and never auto-dismissed (review A3).
    private static var activities: [String: Activity<AgentActivityAttributes>] = [:]

    @discardableResult
    static func start(for session: AgentSession, client: LisaClient? = nil) -> String? {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
        // Already pinned? Update in place rather than stacking a duplicate.
        if let existing = activities[session.sessionId] { update(for: session); return existing.id }
        let attributes = AgentActivityAttributes(
            agent: session.agent,
            project: session.project,
            sessionId: session.sessionId
        )
        let state = contentState(for: session)
        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: staleDate()),
                pushType: .token
            )
            activities[session.sessionId] = activity
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

    /// Push the latest state into a pinned activity, or end it on a terminal state.
    /// Called from the roster SSE merge so the activity actually ticks (and
    /// auto-dismisses) while the app is running, independent of the dead APNs path.
    static func update(for session: AgentSession) {
        guard let activity = activities[session.sessionId] else { return }
        let content = ActivityContent(state: contentState(for: session), staleDate: staleDate())
        if isTerminal(session.state) {
            activities[session.sessionId] = nil
            Task { await activity.end(content, dismissalPolicy: .after(.now + 30)) }
        } else {
            Task { await activity.update(content) }
        }
    }

    private static func contentState(for s: AgentSession) -> AgentActivityAttributes.ContentState {
        AgentActivityAttributes.ContentState(state: s.state, detail: detail(for: s), turns: s.activity?.turnCount ?? 0)
    }
    private static func isTerminal(_ state: String) -> Bool { state == "done" || state == "error" }
    /// Let iOS visually age an activity that stops getting updates (e.g. backgrounded
    /// with no APNs key) instead of showing stale state as live indefinitely.
    private static func staleDate() -> Date { .now + 1800 }   // 30 min

    static func detail(for s: AgentSession) -> String {
        if let pending = s.activity?.pendingPermission { return "⚠ \(pending)" }
        if !s.stateReason.isEmpty { return s.stateReason }
        return s.activity?.lastTools?.last ?? s.state
    }
}
