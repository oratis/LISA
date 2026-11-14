import Foundation
import Combine

struct FleetTask: Decodable, Identifiable, Equatable {
    struct Approval: Decodable, Equatable {
        let tool: String
        let target: String
        let expiresAt: Double
    }
    let id: String
    let hostId: String
    let workspaceName: String
    let state: String
    let createdAt: Double
    let updatedAt: Double
    let lastSeq: Int
    let result: String
    let truncated: Bool
    let approval: Approval?
}

struct FleetEntry: Decodable, Identifiable, Equatable {
    var id: Int { seq }
    let seq: Int
    let at: Double
    let type: String
    var turn: Int? = nil
    var tool: String? = nil
    var target: String? = nil
    var outcome: String? = nil
    var result: String? = nil
    var truncated: Bool? = nil
    var state: String? = nil
    var reason: String? = nil
    var by: String? = nil

    var title: String {
        switch type {
        case "turn_started": return "Turn \(turn ?? 0) started"
        case "turn_completed": return "Turn \(turn ?? 0) completed"
        case "turn_failed": return "Turn \(turn ?? 0) failed"
        case "approval_requested": return "Approval requested · \(tool ?? "") \(target ?? "")"
        case "approval_resolved": return "Approval · \(outcome ?? "resolved")"
        case "tool_blocked": return "Policy blocked · \(tool ?? "") \(target ?? "")"
        case "cancel_requested": return "Stop requested · \(by ?? "")"
        case "run_ended": return "Task ended · \(state ?? "")"
        case "outcome_unknown": return "Mac restarted · outcome needs checking"
        case "owner_released", "orphan_released": return "Previous process released · outcome needs checking"
        case "history_started": return "Earlier task · history starts here"
        default: return "Task update"
        }
    }
}

struct FleetPage: Decodable {
    let run: FleetTask
    let events: [FleetEntry]
    let firstSeq: Int
    let lastSeq: Int
    let gap: Bool
    let reset: Bool
    let more: Bool
}

struct FleetTimeline {
    private(set) var run: FleetTask?
    private(set) var entries: [FleetEntry] = []
    private(set) var cursor = 0
    private(set) var historyLimited = false

    mutating func merge(_ page: FleetPage) {
        if page.reset || run?.id != page.run.id || run?.hostId != page.run.hostId {
            self = FleetTimeline()
        }
        // Even an idle page may report that the host has pruned cached entries.
        entries.removeAll { $0.seq < page.firstSeq }
        var merged = Dictionary(uniqueKeysWithValues: entries.map { ($0.seq, $0) })
        for e in page.events { merged[e.seq] = e }
        entries = merged.values.sorted { $0.seq < $1.seq }
        cursor = entries.last?.seq ?? 0 // never skip unread pages by using run.lastSeq
        historyLimited = page.firstSeq > 1 || page.gap
        run = page.run
    }
}

protocol FleetReading {
    func fleetTasks() async throws -> [FleetTask]
    func fleetEvents(_ id: String, after: Int) async throws -> FleetPage
}

@MainActor
final class FleetPocketModel: ObservableObject {
    @Published private(set) var runs: [FleetTask] = []
    @Published private(set) var timeline = FleetTimeline()
    @Published private(set) var message: String?
    @Published var selection: String? { didSet { if oldValue != selection { generation += 1; timeline = FleetTimeline() } } }
    private var generation = 0
    private var refreshing = false

    func refresh(_ client: FleetReading) async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let expected = generation
        do {
            let next = try await client.fleetTasks()
            guard !Task.isCancelled, expected == generation else { return }
            runs = next
            message = nil
            guard let id = selection else { return }
            guard next.contains(where: { $0.id == id }) else {
                selection = nil
                message = "This task is no longer shared with this Pocket."
                return
            }
            // At most 500 retained entries; each page checks the share again.
            for _ in 0..<5 {
                let page = try await client.fleetEvents(id, after: timeline.cursor)
                guard !Task.isCancelled, expected == generation else { return }
                guard page.run.id == id else { throw LisaError.decode }
                timeline.merge(page)
                if !page.more { break }
            }
        } catch {
            guard !Task.isCancelled, expected == generation else { return }
            if Self.accessLost(error) {
                runs = []
                selection = nil
                timeline = FleetTimeline()
                message = "Access unavailable. Check the task share and secure pairing on this Mac, and update LISA if needed."
            } else {
                message = "Connection interrupted. Showing the last received update; retrying automatically."
            }
        }
    }

    private static func accessLost(_ error: Error) -> Bool {
        if case LisaError.http(let code) = error { return [401, 403, 404].contains(code) }
        if let link = error as? RemoteLinkError {
            switch link {
            case .notAllowed, .signIn, .invalidPeer: return true
            default: break
            }
        }
        return false
    }
}
