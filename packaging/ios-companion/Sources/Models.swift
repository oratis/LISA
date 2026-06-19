import Foundation

// Codable mirrors of the backend's normalized types (src/integrations/types.ts) and
// the JSON shapes the endpoints return. Optional-heavy on purpose — a roster row
// should never fail to decode just because one structural field is absent.

struct AgentSession: Codable, Identifiable, Hashable {
    var agent: String
    var sessionId: String
    var project: String
    var cwd: String?
    var state: String
    var stateReason: String
    /// ISO-8601 string from /api/agents/sessions (the server serializes lastMtime).
    var lastMtime: String?
    var activity: SessionActivity?
    /// "managed" | "pty" — which control-endpoint family drives it. Absent ⇒ observe-only.
    var controllable: String?
    /// An idle claude session that can be adopted via `claude --resume`.
    var resumable: Bool?
    /// When a controllable PTY is a resume-adopt, the real claude sessionId it continues.
    var adoptedSessionId: String?

    var id: String { "\(agent)/\(sessionId)" }
}

struct SessionActivity: Codable, Hashable {
    var turnCount: Int?
    var lastTools: [String]?
    var filesTouched: [String]?
    var lastCommandName: String?
    var lastError: String?
    var gitBranch: String?
    var tokens: TokenUsage?
    var pendingPermission: String?
}

struct TokenUsage: Codable, Hashable {
    var input: Int
    var output: Int
}

struct SessionsResponse: Codable {
    var sessions: [AgentSession]
}

struct DispatchView: Codable, Identifiable, Hashable {
    var id: String
    var agent: String
    var pid: Int
    var cwd: String
    var task: String
    var startedAt: String
    var alive: Bool
    var hasLog: Bool
}

struct DispatchListResponse: Codable {
    var dispatches: [DispatchView]
}

struct IslandPing: Codable {
    var online: Bool
    var mood: String
    var has_unread_idle_message: Bool
    var last_idle_message_text: String?
    var current_desire: String?
    var uptime_sec: Int
}

struct ControlPolicy: Codable, Equatable {
    var remoteControl: Bool
    var remoteAdoptExternal: Bool
}

struct PushPrefs: Codable, Equatable {
    var done: Bool = true
    var error: Bool = true
    var permission: Bool = true
    var idle: Bool = true
    var advisor: Bool = false
}

// ── read-only inspection (/api/soul, /api/memory, /api/skills, /api/tools) ──

struct SoulResponse: Codable {
    var born: Bool
    var summary: SoulSummary?
}

/// Mirrors src/soul/types.ts SoulSummary, but lenient (optional) — a roster
/// glance should render whatever the server sends, not fail on a missing field.
struct SoulSummary: Codable {
    var name: String?
    var identity: String?
    var purpose: String?
    var constitution: String?
    var emotions: Emotions?
    var values: [SoulItem]?
    var opinions: [SoulItem]?
    var desires: [SoulItem]?
    var tampered: [String]?
}

struct Emotions: Codable {
    var values: [String: Double]?
}

/// A values/opinions/desires row. Their exact key varies, so accept several and
/// surface the first present (see ValueEntry/OpinionEntry/DesireEntry server-side).
struct SoulItem: Codable, Hashable {
    var name: String?
    var statement: String?
    var what: String?
    var text: String?
    var summary: String?
    var label: String { statement ?? what ?? text ?? summary ?? name ?? "—" }
}

struct MemoryResponse: Codable {
    var user: String
    var memory: String
}

struct NamedItem: Codable, Identifiable, Hashable {
    var name: String
    var description: String?
    var id: String { name }
}
struct SkillsResponse: Codable { var skills: [NamedItem] }
struct ToolsResponse: Codable { var tools: [NamedItem] }
