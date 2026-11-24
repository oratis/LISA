import Foundation

/// Read-only truthful server capability snapshot (`GET /api/client-capabilities`).
/// Unknown status strings decode safely via `rawValue` so newer servers never break older clients.
struct ClientCapabilityEntry: Decodable, Equatable {
    let status: String
    let reason: String?

    var isAvailable: Bool { status == "available" }
}

struct TasksCapabilityEntry: Decodable, Equatable {
    let status: String
    let reason: String?
    let supportedKinds: [String]

    var isAvailable: Bool { status == "available" }
}

struct ClientCapabilities: Decodable, Equatable {
    let edition: String
    let surface: String
    let profile: String
    let location: String
    let canApprove: Bool
    let tasks: TasksCapabilityEntry
    let approvals: ClientCapabilityEntry
    let connectors: ClientCapabilityEntry
    let localTools: ClientCapabilityEntry
    let cloudWorkspace: ClientCapabilityEntry
    let artifacts: ClientCapabilityEntry

    /// Conservative fallback when talking to an older server without `/api/client-capabilities`.
    static func conservativeFallback(isCloud: Bool) -> ClientCapabilities {
        let disabledTasks = TasksCapabilityEntry(
            status: isCloud ? "disabled" : "available",
            reason: isCloud ? "This server does not report background task support." : nil,
            supportedKinds: isCloud ? [] : ["oneoff", "routine", "watcher", "goal"]
        )
        return ClientCapabilities(
            edition: isCloud ? "cloud" : "mac",
            surface: isCloud ? "cloud" : "local-web",
            profile: isCloud ? "cloud-chat" : "remote-device",
            location: isCloud ? "cloud" : "mac",
            canApprove: false,
            tasks: disabledTasks,
            approvals: ClientCapabilityEntry(status: "disabled", reason: "Approvals require a trusted session."),
            connectors: ClientCapabilityEntry(status: "unsupported", reason: nil),
            localTools: ClientCapabilityEntry(status: "unsupported", reason: nil),
            cloudWorkspace: ClientCapabilityEntry(status: isCloud ? "available" : "needs_setup", reason: nil),
            artifacts: ClientCapabilityEntry(status: disabledTasks.status, reason: disabledTasks.reason)
        )
    }
}

struct LisaTaskSchedule: Decodable, Equatable {
    let expr: String
    let tz: String?
}

struct LisaTaskTrigger: Decodable, Equatable {
    let kind: String
    let every: String?
}

struct LisaGoalMilestone: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let done: Bool
    let evidence: String?
    let updatedAt: Double?
}

struct LisaTask: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let instruction: String
    let host: String?
    let state: String
    let enabled: Bool
    let schedule: LisaTaskSchedule?
    let trigger: LisaTaskTrigger?
    let nextRunAt: Double?
    let lastRunAt: Double?
    let lastSummary: String?
    let pausedReason: String?
    let activeRunId: String?
    let goalMilestones: [LisaGoalMilestone]?
    let goalNextReviewAt: Double?

    var scheduleDisplay: String {
        if let schedule {
            let zone = (schedule.tz?.isEmpty == false) ? schedule.tz! : "local"
            return "\(schedule.expr) (\(zone))"
        }
        if let trigger {
            if let every = trigger.every, !every.isEmpty {
                return "watch:\(trigger.kind) · \(every)"
            }
            return "watch:\(trigger.kind)"
        }
        return kind == "goal" ? "Goal" : "One-off"
    }
}

struct LisaTaskArtifact: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String?
    let value: String?
    let filename: String?
    let previewUrl: String
    let downloadUrl: String

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let filename, !filename.isEmpty { return filename }
        return "Artifact \(id)"
    }
}

struct LisaTaskRun: Decodable, Identifiable, Equatable {
    let id: String
    let taskId: String
    let startedAt: Double
    let endedAt: Double?
    let state: String
    let summary: String?
    let error: String?
    let artifacts: [LisaTaskArtifact]?
}

struct LisaTaskArtifactPreview: Equatable {
    let title: String
    let contentType: String
    let text: String?
    let linkURL: URL?
    let byteCount: Int
}
