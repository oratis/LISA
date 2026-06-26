import Foundation

struct ServerConfig: Equatable {
    var host: String          // "192.168.3.162", "mac.tailnet.ts.net", or "lisa-cloud-xxx.run.app"
    var port: Int
    var token: String?        // device or global token (nil only for loopback, unused from a phone)
    var scheme: String = "http"  // "http" for a LAN Mac; "https" for a cloud URL

    var isConfigured: Bool { !host.isEmpty && port > 0 }
    /// Base URL. Drop the port when it's the scheme's default (so a cloud URL is
    /// `https://host`, not `https://host:443`).
    var baseURL: URL? {
        let standardPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        return URL(string: standardPort ? "\(scheme)://\(host)" : "\(scheme)://\(host):\(port)")
    }
}

enum LisaError: LocalizedError {
    case notConfigured
    case http(Int)
    case decode

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Not paired yet — add your Mac in Settings."
        case .http(let code): return "Server returned HTTP \(code)."
        case .decode: return "Couldn't read the server response."
        }
    }
}

/// Thin async client for the Lisa web API. Plain class (Swift 5 mode); pass a fresh
/// instance when the config changes.
final class LisaClient {
    var config: ServerConfig
    private let session: URLSession

    init(config: ServerConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    /// URL for a server asset (e.g. a mood portrait at /assets/lisa/<slug>.png),
    /// carrying the token as a query param so AsyncImage — which can't set an
    /// Authorization header — still authenticates against a non-loopback server.
    func assetURL(_ path: String) -> URL? {
        guard config.isConfigured, let base = config.baseURL,
              let abs = URL(string: path, relativeTo: base),
              var comps = URLComponents(url: abs, resolvingAgainstBaseURL: true) else { return nil }
        if let token = config.token, !token.isEmpty {
            comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
        }
        return comps.url
    }

    func makeRequest(_ path: String, method: String = "GET", json: [String: Any]? = nil) throws -> URLRequest {
        guard config.isConfigured, let base = config.baseURL, let url = URL(string: path, relativeTo: base) else {
            throw LisaError.notConfigured
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let token = config.token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        return req
    }

    private func decode<T: Decodable>(_ path: String, method: String = "GET", json: [String: Any]? = nil, as: T.Type) async throws -> T {
        let req = try makeRequest(path, method: method, json: json)
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw LisaError.http(code) }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw LisaError.decode }
    }

    @discardableResult
    private func fire(_ path: String, method: String = "POST", json: [String: Any]? = nil) async throws -> Int {
        let req = try makeRequest(path, method: method, json: json)
        let (_, resp) = try await session.data(for: req)
        return (resp as? HTTPURLResponse)?.statusCode ?? -1
    }

    // ── read ──
    func sessions() async throws -> [AgentSession] { try await decode("/api/agents/sessions", as: SessionsResponse.self).sessions }
    func dispatchList() async throws -> [DispatchView] { try await decode("/api/dispatch/list", as: DispatchListResponse.self).dispatches }
    func dispatchStatus(id: String) async throws -> DispatchStatus {
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id
        return try await decode("/api/dispatch/status?id=\(enc)", as: DispatchStatus.self)
    }
    func islandPing() async throws -> IslandPing { try await decode("/api/island/ping", as: IslandPing.self) }

    // ── read: mail (read-only digest) ──
    func mailDigest() async throws -> MailDigest? { try await decode("/api/mail/digest", as: MailDigestResponse.self).digest }
    func mailAccounts() async throws -> MailAccountsResponse { try await decode("/api/mail/accounts", as: MailAccountsResponse.self) }
    func controlPolicy() async throws -> ControlPolicy { try await decode("/api/control/policy", as: ControlPolicy.self) }

    // ── proactive mode (autonomy on/off) ──
    func autonomyState() async throws -> Bool { try await decode("/api/autonomy/state", as: AutonomyState.self).enabled }
    func setAutonomyState(_ enabled: Bool) async throws { try await fire("/api/autonomy/state", json: ["enabled": enabled]) }

    // ── read: inspection ──
    func soul() async throws -> SoulResponse { try await decode("/api/soul", as: SoulResponse.self) }
    func memory() async throws -> MemoryResponse { try await decode("/api/memory", as: MemoryResponse.self) }
    func skills() async throws -> [NamedItem] { try await decode("/api/skills", as: SkillsResponse.self).skills }
    func tools() async throws -> [NamedItem] { try await decode("/api/tools", as: ToolsResponse.self).tools }

    // ── read: Reve ──
    func recap(sinceMinutes: Int = 120) async throws -> RecapResponse {
        try await decode("/api/agents/recap?sinceMinutes=\(sinceMinutes)", as: RecapResponse.self)
    }
    func advisorLatest() async throws -> AdvisorResponse { try await decode("/api/advisor/latest", as: AdvisorResponse.self) }
    func advisorDismiss(id: String, category: String?) async throws {
        try await fire("/api/advisor/dismiss", json: ["id": id, "category": category ?? ""])
    }

    // ── Sense: consent (revoke-only from a phone) + events ──
    func consent() async throws -> [ConsentRow] { try await decode("/api/consent", as: ConsentResponse.self).grants }
    func consentRevoke(signal: String) async throws { try await fire("/api/consent/revoke", json: ["signal": signal]) }
    func consentRevokeAll() async throws { try await fire("/api/consent/revoke-all") }
    func senseRecent() async throws -> [SenseEvent] { try await decode("/api/sense/recent", as: SenseResponse.self).events }

    // ── read: paired devices (revoke is a Mac-only action) ──
    func devices() async throws -> [DeviceInfo] { try await decode("/api/devices", as: DevicesResponse.self).devices }

    // ── control: managed agents ──
    func managedStart(task: String) async throws { try await fire("/api/agents/managed/start", json: ["task": task]) }
    func managedSend(_ id: String, _ text: String) async throws { try await fire("/api/agents/managed/\(id)/send", json: ["text": text]) }
    func managedCancel(_ id: String) async throws { try await fire("/api/agents/managed/\(id)/cancel") }
    func managedApprove(_ id: String, allow: Bool) async throws { try await fire("/api/agents/managed/\(id)/approve", json: ["allow": allow]) }

    // ── control: PTY agents ──
    /// Spawn a fresh real CLI under a PTY (agent = "claude" | "codex"). Returns
    /// the HTTP code (503 ⇒ the PTY spike is off on the Mac: LISA_PTY_AGENTS=1).
    func ptyStart(agent: String, task: String) async throws -> Int {
        try await fire("/api/agents/pty/start", json: ["agent": agent, "task": task])
    }
    func ptySend(_ id: String, _ text: String) async throws { try await fire("/api/agents/pty/\(id)/send", json: ["text": text]) }
    func ptyCancel(_ id: String) async throws { try await fire("/api/agents/pty/\(id)/cancel") }
    func ptyOutput(_ id: String) async throws -> String {
        struct R: Codable { var ok: Bool; var output: String? }
        return (try await decode("/api/agents/pty/\(id)/output", as: R.self)).output ?? ""
    }
    /// Adopt an idle claude session by id (resume-adopt). Returns the HTTP code
    /// (409 ⇒ the session is still live; 403 ⇒ remote adoption disabled).
    func adopt(sessionId: String) async throws -> Int {
        try await fire("/api/agents/pty/start", json: ["agent": "claude", "resumeSessionId": sessionId])
    }

    // ── push ──
    /// Register (token non-empty) a Live Activity push token for a session.
    func registerLiveActivity(sessionId: String, token: String) async throws {
        try await fire("/api/push/live-activity", json: ["sessionId": sessionId, "token": token])
    }
    func pushRegister(kind: String, target: String, prefs: PushPrefs) async throws {
        let p: [String: Any] = ["done": prefs.done, "error": prefs.error, "permission": prefs.permission, "idle": prefs.idle, "advisor": prefs.advisor]
        try await fire("/api/push/register", json: ["kind": kind, "target": target, "prefs": p])
    }

    // ── chat ──
    func chatStream(_ message: String) -> AsyncThrowingStream<SSEMessage, Error> {
        sse("/chat", method: "POST", json: ["message": message])
    }
    func eventsStream() -> AsyncThrowingStream<SSEMessage, Error> {
        sse("/events")
    }

    /// Open an SSE stream and yield each decoded `{type, ...}` payload.
    func sse(_ path: String, method: String = "GET", json: [String: Any]? = nil) -> AsyncThrowingStream<SSEMessage, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let req = try makeRequest(path, method: method, json: json)
                    let (bytes, resp) = try await session.bytes(for: req)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                    guard (200..<300).contains(code) else { continuation.finish(throwing: LisaError.http(code)); return }
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            if !dataLines.isEmpty {
                                let joined = dataLines.joined(separator: "\n")
                                if let msg = SSEMessage(json: joined) { continuation.yield(msg) }
                                dataLines.removeAll()
                            }
                        } else if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(line.hasPrefix("data: ") ? 6 : 5)))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// One decoded SSE `data:` line: its `type` plus the raw JSON object for field access.
struct SSEMessage {
    let type: String
    let object: [String: Any]

    init?(json: String) {
        guard let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = obj["type"] as? String else { return nil }
        self.type = type
        self.object = obj
    }

    var text: String? { object["text"] as? String }
    var slug: String? { object["slug"] as? String }

    /// Decode the payload as an AgentSession (for `agent_session_update`).
    var agentSession: AgentSession? {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(AgentSession.self, from: data)
    }
}
