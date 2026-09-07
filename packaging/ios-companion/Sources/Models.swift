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
    /// Normalized to an ISO-8601 string. The REST `/api/agents/sessions` already
    /// serializes it as ISO, but the `agent_session_update` SSE sends raw epoch-ms
    /// (a number) — so decode tolerates both (a number → ISO), else a present-but-
    /// wrong-type value would throw and silently drop every live roster update.
    var lastMtime: String?
    var activity: SessionActivity?
    /// "managed" | "pty" — which control-endpoint family drives it. Absent ⇒ observe-only.
    var controllable: String?
    /// An idle claude session that can be adopted via `claude --resume`.
    var resumable: Bool?
    /// When a controllable PTY is a resume-adopt, the real claude sessionId it continues.
    var adoptedSessionId: String?

    var id: String { "\(agent)/\(sessionId)" }

    init(agent: String, sessionId: String, project: String, cwd: String? = nil,
         state: String, stateReason: String, lastMtime: String? = nil,
         activity: SessionActivity? = nil, controllable: String? = nil,
         resumable: Bool? = nil, adoptedSessionId: String? = nil) {
        self.agent = agent; self.sessionId = sessionId; self.project = project; self.cwd = cwd
        self.state = state; self.stateReason = stateReason; self.lastMtime = lastMtime
        self.activity = activity; self.controllable = controllable
        self.resumable = resumable; self.adoptedSessionId = adoptedSessionId
    }

    enum CodingKeys: String, CodingKey {
        case agent, sessionId, project, cwd, state, stateReason, lastMtime
        case activity, controllable, resumable, adoptedSessionId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(String.self, forKey: .agent)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        project = (try? c.decode(String.self, forKey: .project)) ?? ""
        cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
        state = (try? c.decode(String.self, forKey: .state)) ?? "idle"
        stateReason = (try? c.decode(String.self, forKey: .stateReason)) ?? ""
        if let s = try? c.decodeIfPresent(String.self, forKey: .lastMtime) {
            lastMtime = s
        } else if let n = try? c.decodeIfPresent(Double.self, forKey: .lastMtime) {
            lastMtime = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: n / 1000))
        } else {
            lastMtime = nil
        }
        activity = try? c.decodeIfPresent(SessionActivity.self, forKey: .activity)
        controllable = try? c.decodeIfPresent(String.self, forKey: .controllable)
        resumable = try? c.decodeIfPresent(Bool.self, forKey: .resumable)
        adoptedSessionId = try? c.decodeIfPresent(String.self, forKey: .adoptedSessionId)
    }
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
    /// running | ok | failed | unknown. Optional so an older server (which
    /// sent only `alive`) still decodes; `kind` falls back to alive then.
    var status: String?
    var exitCode: Int?
    var exitSignal: String?
    var exitedAt: String?

    var kind: DispatchKind { DispatchKind(status, alive: alive) }
}

/// What actually happened to a dispatch.
///
/// `alive: false` on its own says nothing about success — the agent is spawned
/// detached, so a crash, an OOM kill and a clean finish are indistinguishable
/// from the pid. The roster used to render all three as one grey "exited".
enum DispatchKind {
    case running, ok, failed, unknown

    init(_ raw: String?, alive: Bool) {
        switch raw {
        case "running": self = .running
        case "ok": self = .ok
        case "failed": self = .failed
        case "unknown": self = .unknown
        default: self = alive ? .running : .unknown   // pre-status server
        }
    }

    var label: String {
        switch self {
        case .running: return "running"
        case .ok: return "finished"
        case .failed: return "failed"
        case .unknown: return "status unknown"
        }
    }

    /// Spoken by VoiceOver — the dot's colour is not available to it.
    var accessibleLabel: String {
        switch self {
        case .running: return "running"
        case .ok: return "finished successfully"
        case .failed: return "failed"
        case .unknown: return "exited, status not captured"
        }
    }
}

struct DispatchListResponse: Codable {
    var dispatches: [DispatchView]
}

/// /api/dispatch/status?id= — a DispatchView plus a captured log tail.
struct DispatchStatus: Codable {
    var ok: Bool
    var id: String?
    var agent: String?
    var task: String?
    var startedAt: String?
    var alive: Bool?
    var tail: String?
    var status: String?
    var exitCode: Int?
    var exitSignal: String?
    var exitedAt: String?

    var kind: DispatchKind { DispatchKind(status, alive: alive ?? false) }
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

// /api/history?page=N — newest page first (page 0), older pages as N grows.
struct HistoryResponse: Codable { var messages: [HistoryMessage]; var hasMore: Bool; var page: Int }
struct HistoryMessage: Codable { var role: String; var content: String }

/// /api/autonomy/state — the "Proactive mode" master switch (idle + heartbeat).
struct AutonomyState: Codable, Equatable {
    var enabled: Bool
}

struct PushPrefs: Codable, Equatable {
    var done: Bool = true
    var error: Bool = true
    var permission: Bool = true
    var idle: Bool = true
    var advisor: Bool = false
    var mail: Bool = true
    /// Daily knowledge-base feeds brief — the server has always had it; the app
    /// silently left it at the server default and never showed the switch.
    var brief: Bool = true

    /// Tolerant: a Mac that predates a preference just doesn't send that key, and
    /// the missing switch should fall back to its default rather than throwing
    /// away the whole subscription.
    init(done: Bool = true, error: Bool = true, permission: Bool = true, idle: Bool = true,
         advisor: Bool = false, mail: Bool = true, brief: Bool = true) {
        self.done = done; self.error = error; self.permission = permission
        self.idle = idle; self.advisor = advisor; self.mail = mail; self.brief = brief
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func flag(_ k: CodingKeys, _ fallback: Bool) -> Bool {
            (try? c.decodeIfPresent(Bool.self, forKey: k)) .flatMap { $0 } ?? fallback
        }
        done = flag(.done, true)
        error = flag(.error, true)
        permission = flag(.permission, true)
        idle = flag(.idle, true)
        advisor = flag(.advisor, false)
        mail = flag(.mail, true)
        brief = flag(.brief, true)
    }

    /// The wire shape `/api/push/register` and `/api/push/prefs` expect.
    var json: [String: Any] {
        ["done": done, "error": error, "permission": permission,
         "idle": idle, "advisor": advisor, "mail": mail, "brief": brief]
    }
}

// ── Mail (read-only digest + accounts) ──
struct MailItemDTO: Codable, Identifiable, Hashable {
    var uid: String
    var accountId: String
    var from: String
    var subject: String
    var importance: Int
    var reason: String
    var category: String
    var id: String { accountId + ":" + uid }
}
struct MailDigest: Codable {
    var date: String
    var total: Int
    var unread: Int
    var summary: String
    var needsYou: [MailItemDTO]
}
struct MailDigestResponse: Codable { var digest: MailDigest? }
struct MailAccountDTO: Codable, Identifiable, Hashable {
    var id: String
    var email: String
    var provider: String
    var enabled: Bool
}
struct MailAccountsResponse: Codable { var accounts: [MailAccountDTO]; var consent: Bool }

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
    var what: String?       // DesireEntry
    var stance: String?     // OpinionEntry
    var title: String?      // ValueEntry (headline)
    var body: String?       // ValueEntry (detail)
    var text: String?
    var summary: String?
    var slug: String?
    // Each entry type carries a different headline key (values→title, opinions→
    // stance, desires→what); pick the first present. Without title/stance, values
    // and opinions rendered "—" (review A4).
    var label: String { statement ?? what ?? stance ?? title ?? text ?? summary ?? body ?? name ?? slug ?? "—" }
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

// ── Reve (/api/agents/recap, /api/advisor/latest) ──

struct RecapResponse: Codable {
    var text: String
    var sinceMinutes: Int?
}

struct AdvisorSuggestion: Codable, Identifiable {
    var id: String
    var category: String?
    var urgency: String?
    var text: String
}
struct AdvisorResponse: Codable {
    var suggestions: [AdvisorSuggestion]
    var at: String?
}

// ── Sense (/api/consent, /api/sense/recent) ──

struct ConsentRow: Codable, Identifiable {
    var signal: String
    var granted: Bool
    var grantedAt: String?
    var description: String?
    var id: String { signal }
}
struct ConsentResponse: Codable { var grants: [ConsentRow] }

struct SenseEvent: Codable, Identifiable {
    var signal: String
    var kind: String
    var app: String?
    var title: String?
    var summary: String
    var ts: Double
    var id: String { "\(signal)/\(kind)/\(ts)" }
}
struct SenseResponse: Codable { var events: [SenseEvent] }

// ── Devices (/api/devices) — list is token-auth; revoke is Mac-only ──
struct DeviceInfo: Codable, Identifiable {
    var id: String
    var name: String
    var platform: String
    var createdAt: Double?
    var lastSeenAt: Double?
}
struct DevicesResponse: Codable { var devices: [DeviceInfo] }

// ── Lisa's own chat sessions (/api/sessions — contract: LisaSessionsResponse,
// PLAN_UI_SESSION_SHELL_v1.1). The on-disk path never reaches the wire. ──
struct LisaSessionInfo: Codable, Identifiable, Hashable {
    var id: String
    var startedAt: String
    var cwd: String
    var model: String
    var messageCount: Int
    var lastUserMessage: String?
    var firstUserMessage: String?
    /// Display name mirrors the web tree: the opening request, else the
    /// latest one, else the raw id (F2 auto-naming).
    var displayName: String { firstUserMessage ?? lastUserMessage ?? id }
}
struct LisaSessionsResponse: Codable { var sessions: [LisaSessionInfo] }
struct LisaSessionMutation: Codable { var ok: Bool; var id: String }
