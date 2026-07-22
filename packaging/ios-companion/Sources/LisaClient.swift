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
    /// True when `host` is an RFC-1918 private LAN IPv4 (192.168/16, 10/8,
    /// 172.16–31/12) — reachable only on that same local network, not off it. A
    /// Tailscale `100.64/10` address is deliberately NOT counted (it's reachable
    /// across the tailnet). Drives the "you've left your Mac's Wi-Fi" guidance.
    var isPrivateLAN: Bool {
        let p = host.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4, p.allSatisfy({ (0...255).contains($0) }) else { return false }
        if p[0] == 192 && p[1] == 168 { return true }
        if p[0] == 10 { return true }
        if p[0] == 172 && (16...31).contains(p[1]) { return true }
        return false
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

    /// Exchange a Sign in with Apple identity token for the cloud instance's
    /// session token (`POST /api/auth/apple`). Unauthenticated by design — this
    /// is the call that *mints* the token — so it's a static helper that takes the
    /// bare cloud base (host/scheme/port, no token). Throws `LisaError.http` for a
    /// disabled instance (404) or a rejected sign-in (401/403).
    static func exchangeAppleToken(base: ServerConfig, identityToken: String,
                                   session: URLSession = .shared) async throws -> String {
        guard let baseURL = base.baseURL, let url = URL(string: "/api/auth/apple", relativeTo: baseURL) else {
            throw LisaError.notConfigured
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["identityToken": identityToken])
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw LisaError.http(code) }
        struct R: Decodable { let token: String }
        guard let r = try? JSONDecoder().decode(R.self, from: data), !r.token.isEmpty else {
            throw LisaError.decode
        }
        return r.token
    }

    /// Email-account sign-in / registration against a LISA Cloud instance
    /// (`POST /api/auth/login` / `/register` — PLAN_ACCOUNTS_BILLING B1). Like
    /// `exchangeAppleToken`, this *mints* access, so it's a static helper over the
    /// bare cloud base. Returns the account session token. Throws `LisaError.http`
    /// with the server's typed status: 401 bad credentials, 409 email taken,
    /// 429 throttled, 404 instance without accounts.
    static func emailAuth(base: ServerConfig, email: String, password: String,
                          register: Bool, session: URLSession = .shared) async throws -> String {
        let path = register ? "/api/auth/register" : "/api/auth/login"
        guard let baseURL = base.baseURL, let url = URL(string: path, relativeTo: baseURL) else {
            throw LisaError.notConfigured
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw LisaError.http(code) }
        struct R: Decodable { let token: String }
        guard let r = try? JSONDecoder().decode(R.self, from: data), !r.token.isEmpty else {
            throw LisaError.decode
        }
        return r.token
    }

    /// The signed-in account behind the current session (`GET /api/auth/me`).
    /// `signedIn: false` means the connection authenticates with a legacy shared
    /// or device token rather than a LISA account.
    struct AccountMe: Decodable, Equatable {
        var signedIn: Bool
        var uid: String?
        var kind: String?
        var email: String?
        var verified: Bool?
        var plan: String?
    }

    func authMe() async throws -> AccountMe {
        try await decode("/api/auth/me", as: AccountMe.self)
    }

    /// In-app account deletion (App Store 5.1.1(v)) — `DELETE /api/account`.
    /// Only works when the connection uses an account session.
    func deleteAccount() async throws {
        struct R: Decodable { let ok: Bool }
        _ = try await decode("/api/account", method: "DELETE", as: R.self)
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

    /// `timeout` bounds a short REST call so an unreachable host (a paired LAN IP
    /// off Wi-Fi) fails fast + clean instead of hanging on the 60s default. Left
    /// nil for the long-lived SSE stream (`sse()`), which must not time out on idle.
    func makeRequest(_ path: String, method: String = "GET", json: [String: Any]? = nil,
                     timeout: TimeInterval? = nil) throws -> URLRequest {
        guard config.isConfigured, let base = config.baseURL, let url = URL(string: path, relativeTo: base) else {
            throw LisaError.notConfigured
        }
        var req = URLRequest(url: url)
        if let timeout { req.timeoutInterval = timeout }
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

    /// Timeout for short REST calls (SSE opts out via nil in makeRequest).
    private static let restTimeout: TimeInterval = 10

    private func decode<T: Decodable>(_ path: String, method: String = "GET", json: [String: Any]? = nil, as: T.Type) async throws -> T {
        let req = try makeRequest(path, method: method, json: json, timeout: Self.restTimeout)
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw LisaError.http(code) }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw LisaError.decode }
    }

    /// Fire a mutating request and return the HTTP status WITHOUT throwing on a
    /// non-2xx — for the few call sites that branch on a specific code (503 ⇒ PTY
    /// off, 409 ⇒ session live, 403 ⇒ remote adoption disabled).
    @discardableResult
    private func fireCode(_ path: String, method: String = "POST", json: [String: Any]? = nil) async throws -> Int {
        let req = try makeRequest(path, method: method, json: json, timeout: Self.restTimeout)
        let (_, resp) = try await session.data(for: req)
        return (resp as? HTTPURLResponse)?.statusCode ?? -1
    }

    /// Fire a mutating request that MUST succeed; throws `LisaError.http(code)` on
    /// any non-2xx so control/mutation actions never fail silently (the #1 review
    /// finding — a remote phone blocked by the control policy got 403 on every tap
    /// with zero feedback). This is the default for all the action methods below.
    private func fire(_ path: String, method: String = "POST", json: [String: Any]? = nil) async throws {
        let code = try await fireCode(path, method: method, json: json)
        guard (200..<300).contains(code) else { throw LisaError.http(code) }
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
        try await fireCode("/api/agents/pty/start", json: ["agent": agent, "task": task])
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
        try await fireCode("/api/agents/pty/start", json: ["agent": "claude", "resumeSessionId": sessionId])
    }

    // ── push ──
    /// Register (token non-empty) a Live Activity push token for a session.
    func registerLiveActivity(sessionId: String, token: String) async throws {
        try await fire("/api/push/live-activity", json: ["sessionId": sessionId, "token": token])
    }
    func pushRegister(kind: String, target: String, prefs: PushPrefs) async throws {
        let p: [String: Any] = ["done": prefs.done, "error": prefs.error, "permission": prefs.permission, "idle": prefs.idle, "advisor": prefs.advisor, "mail": prefs.mail]
        try await fire("/api/push/register", json: ["kind": kind, "target": target, "prefs": p])
    }

    // ── chat ──
    func history(page: Int = 0) async throws -> HistoryResponse {
        try await decode("/api/history?page=\(page)", as: HistoryResponse.self)
    }
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
