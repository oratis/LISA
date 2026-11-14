import Foundation

struct ServerConfig: Hashable {
    var host: String          // "192.168.3.162", "mac.tailnet.ts.net", or "lisa-cloud-xxx.run.app"
    var port: Int
    var token: String?        // device or global token (nil only for loopback, unused from a phone)
    var scheme: String = "http"  // "http" for a LAN Mac; "https" for a cloud URL
    var remoteMac: RemoteMacTarget? = nil

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
    case secureStorage
    /// A bare non-2xx status (older call sites and tests). New code throws `.server`.
    case http(Int)
    /// A non-2xx answer with the server's error code and message (issue #487).
    case server(ServerFailure)
    case decode
    case unsupportedAPIVersion(Int)

    var errorDescription: String? {
        switch self {
        case .secureStorage: return "Couldn't save your connection in Keychain. Unlock your device and try again."
        case .notConfigured: return "Connect to LISA Cloud or pair your Mac in Settings."
        case .server(let failure):
            return failure.message ?? LisaError.http(failure.status).errorDescription
        case .http(403):
            return "Lisa refused this request (HTTP 403)."
        case .http(let code): return "Server returned HTTP \(code)."
        case .decode: return "Couldn't read the server response."
        case .unsupportedAPIVersion(let version):
            return "This Lisa server uses API v\(version). Update Lisa Pocket to reconnect."
        }
    }
}

enum LisaAPICompatibility {
    /// Missing means a pre-contract server and remains accepted as legacy v1.
    /// Additive fields within v1 are handled by Swift's tolerant Codable models.
    static func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse,
              let raw = http.value(forHTTPHeaderField: LisaAPIContract.versionHeader) else { return }
        guard let majorText = raw.split(separator: ".", maxSplits: 1).first,
              let major = Int(majorText),
              major > 0 else { throw LisaError.decode }
        if major > LisaAPIContract.supportedMajorVersion {
            throw LisaError.unsupportedAPIVersion(major)
        }
    }
}

/// Thin async client for the Lisa web API. Plain class (Swift 5 mode); pass a fresh
/// instance when the config changes.
final class LisaClient: FleetReading {
    var config: ServerConfig
    private let session: URLSession
    private let remote: RemoteMacTransport?
    /// Called with a renewed account session from the `x-lisa-session` response
    /// header. AppState stores it without resetting the connection (#484).
    var onSessionRenewed: ((String, String) -> Void)?

    /// Every request carries its credential as a Bearer header, so cookies are
    /// never needed — and a server-set `lisa_token` cookie would outlive Unpair
    /// and sign-out outside the Keychain (#493).
    static let defaultSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        return URLSession(configuration: configuration)
    }()

    /// Response header carrying a renewed account session (server: src/web/server.ts).
    static let renewedSessionHeader = "x-lisa-session"

    init(config: ServerConfig, session: URLSession = LisaClient.defaultSession) {
        self.config = config
        self.session = session
        self.remote = config.remoteMac.map { RemoteMacTransport(target: $0) }
    }

    /// Delete any `lisa_token` cookie an older build let URLSession.shared keep
    /// for this server (#493).
    static func forgetCookies(for config: ServerConfig) {
        guard let url = config.baseURL else { return }
        for cookie in HTTPCookieStorage.shared.cookies(for: url) ?? [] {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }

    /// Hand a renewed session to the app when the server sent one.
    private func captureRenewal(_ response: URLResponse) {
        guard remote == nil, let previous = config.token,
              let old = SessionToken.claims(previous),
              let fresh = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: Self.renewedSessionHeader),
              let renewed = SessionToken.claims(fresh), renewed.uid == old.uid,
              renewed.expiresAt > old.expiresAt else { return }
        config.token = fresh
        onSessionRenewed?(fresh, previous)
    }

    func invalidate() { if let remote { Task { await remote.invalidate() } } }
    func networkChanged() { if let remote { Task { await remote.networkChanged() } } }

    struct RelayHost: Decodable, Identifiable {
        let id: String
        let name: String
        let publicKey: String
        let online: Bool
    }
    func remoteMacs() async throws -> [RelayHost] {
        struct Reply: Decodable { let hosts: [RelayHost] }
        return try await decode("/api/relay/macs", as: Reply.self).hosts
    }
    func fleetTasks() async throws -> [FleetTask] {
        struct Reply: Decodable { let runs: [FleetTask] }
        return try await decode("/api/agent-host/v1/view/runs", as: Reply.self).runs
    }
    func fleetEvents(_ id: String, after: Int) async throws -> FleetPage {
        guard UUID(uuidString: id) != nil else { throw LisaError.decode }
        return try await decode("/api/agent-host/v1/view/runs/\(id.lowercased())/events?after=\(max(0, after))&limit=100", as: FleetPage.self)
    }

    func data(for request: URLRequest, path: String) async throws -> (Data, URLResponse) {
        if let remote {
            let (data, response) = try await remote.data(path: path, method: request.httpMethod ?? "GET", body: request.httpBody)
            return (data, response)
        }
        let (data, response) = try await session.data(for: request)
        captureRenewal(response)
        return (data, response)
    }

    /// Exchange a Sign in with Apple identity token for the cloud instance's
    /// session token (`POST /api/auth/apple`). Unauthenticated by design — this
    /// is the call that *mints* the token — so it's a static helper that takes the
    /// bare cloud base (host/scheme/port, no token). Throws `LisaError.http` for a
    /// disabled instance (404) or a rejected sign-in (401/403).
    /// `rawNonce` is the un-hashed nonce this sign-in minted (#261); the server
    /// hashes it and compares against the token's `nonce` claim, which proves
    /// the token was issued for THIS request. nil ⇒ omitted (older instances).
    static func exchangeAppleToken(base: ServerConfig, identityToken: String, rawNonce: String? = nil,
                                   authorizationCode: String? = nil,
                                   session: URLSession = LisaClient.defaultSession) async throws -> String {
        guard let baseURL = base.baseURL, let url = URL(string: "/api/auth/apple", relativeTo: baseURL) else {
            throw LisaError.notConfigured
        }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: String] = ["identityToken": identityToken]
        if let rawNonce { payload["nonce"] = rawNonce }
        if let authorizationCode { payload["authorizationCode"] = authorizationCode }
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, resp) = try await session.data(for: req)
        try LisaAPICompatibility.validate(resp)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw LisaError.server(.from(resp, body: data)) }
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
                          register: Bool, session: URLSession = LisaClient.defaultSession) async throws -> String {
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
        try LisaAPICompatibility.validate(resp)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw LisaError.server(.from(resp, body: data)) }
        struct R: Decodable { let token: String }
        guard let r = try? JSONDecoder().decode(R.self, from: data), !r.token.isEmpty else {
            throw LisaError.decode
        }
        return r.token
    }

    /// Which sign-in surfaces an instance offers (`GET /api/auth/config`).
    /// Public, unauthenticated, and free of secrets — OAuth client ids identify
    /// the app rather than authorize it.
    struct AuthConfig: Decodable {
        struct Google: Decodable {
            let webClientId: String?
            let iosClientId: String?
        }
        struct DataProcessing: Decodable, Equatable {
            let version: Int
            let recipients: [String]
        }
        let accounts: Bool?
        let google: Google?
        let dataProcessing: DataProcessing?
    }

    static func authConfig(base: ServerConfig, session: URLSession = LisaClient.defaultSession) async throws -> AuthConfig {
        guard let baseURL = base.baseURL, let url = URL(string: "/api/auth/config", relativeTo: baseURL) else {
            throw LisaError.notConfigured
        }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "GET"
        let (data, resp) = try await session.data(for: req)
        try LisaAPICompatibility.validate(resp)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else { throw LisaError.server(.from(resp, body: data)) }
        guard let cfg = try? JSONDecoder().decode(AuthConfig.self, from: data) else { throw LisaError.decode }
        return cfg
    }

    /// Exchange a Google ID token for the instance's session token
    /// (`POST /api/auth/google`). Mints access, so it takes the bare cloud base.
    static func exchangeGoogleToken(base: ServerConfig, idToken: String, nonce: String?,
                                    session: URLSession = LisaClient.defaultSession) async throws -> String {
        var payload = ["idToken": idToken]
        if let nonce { payload["nonce"] = nonce }
        let data = try await postAuth(base: base, path: "/api/auth/google", payload: payload, session: session)
        struct R: Decodable { let token: String }
        guard let r = try? JSONDecoder().decode(R.self, from: data), !r.token.isEmpty else {
            throw LisaError.decode
        }
        return r.token
    }

    /// A refusal from the sign-in-by-code endpoints, carrying the server's typed
    /// reason. The status alone can't tell "a code just went out" from "you've
    /// asked too many times today", and those need different words.
    struct SignInCodeError: Error {
        let status: Int
        /// Server code — otp_cooldown, otp_daily_cap, bad_code, expired,
        /// no_pending, too_many_attempts, invalid_email, email_typo,
        /// undeliverable_email, rate_limited. Empty if the body carried none.
        let reason: String
        /// The corrected domain, when the server recognised a typo.
        let suggestion: String?
        /// Seconds until another code may be requested (`otp_cooldown`).
        var retryAfterSec: Int? = nil
    }

    private static func postAuth(
        base: ServerConfig,
        path: String,
        payload: [String: String],
        session: URLSession,
    ) async throws -> Data {
        guard let baseURL = base.baseURL, let url = URL(string: path, relativeTo: baseURL) else {
            throw LisaError.notConfigured
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, resp) = try await session.data(for: req)
        try LisaAPICompatibility.validate(resp)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            struct E: Decodable { let error: String?; let suggestion: String?; let retryAfterSec: Int? }
            let body = try? JSONDecoder().decode(E.self, from: data)
            throw SignInCodeError(status: status, reason: body?.error ?? "", suggestion: body?.suggestion,
                                  retryAfterSec: body?.retryAfterSec)
        }
        return data
    }

    /// Ask for a one-time sign-in code (`POST /api/auth/otp/request`,
    /// PLAN_AUTH_OTP_GOOGLE A2). Returns whether the mail actually went out —
    /// false means the instance has no mail provider configured, which the UI
    /// must say plainly rather than leaving someone waiting for a code.
    static func requestSignInCode(base: ServerConfig, email: String,
                                  session: URLSession = LisaClient.defaultSession) async throws -> Bool {
        let data = try await postAuth(base: base, path: "/api/auth/otp/request",
                                      payload: ["email": email], session: session)
        struct R: Decodable { let sent: Bool? }
        return (try? JSONDecoder().decode(R.self, from: data))?.sent ?? true
    }

    /// Spend a code (`POST /api/auth/otp/verify`) and get the account session
    /// token. Registers the account if the address is new — reading the mail is
    /// the proof, so there's no separate sign-up step.
    static func verifySignInCode(base: ServerConfig, email: String, code: String,
                                 session: URLSession = LisaClient.defaultSession) async throws -> String {
        let data = try await postAuth(base: base, path: "/api/auth/otp/verify",
                                      payload: ["email": email, "code": code], session: session)
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
        var appleUserId: String?
        /// When the presented session expires (epoch ms); newer servers only.
        var sessionExpiresAt: Double?
    }

    func authMe() async throws -> AccountMe {
        try await decode("/api/auth/me", as: AccountMe.self)
    }

    /// A fresh account session for this one (`POST /api/auth/refresh`, #484).
    struct RefreshedSession: Decodable { let token: String; let expiresAt: Double? }
    func refreshSession() async throws -> RefreshedSession {
        let r = try await decode("/api/auth/refresh", method: "POST", as: RefreshedSession.self)
        guard SessionToken.claims(r.token) != nil else { throw LisaError.decode }
        return r
    }

    /// Revoke this session on the server (`POST /api/auth/logout`), or every
    /// session of the account (`/api/auth/logout-all`). Older servers only
    /// expire the cookie; the local sign-out happens either way (#493).
    func logout(everywhere: Bool = false) async throws {
        try await fire(everywhere ? "/api/auth/logout-all" : "/api/auth/logout")
    }

    /// The signed-in account's quota window + balance (`GET /api/billing/quota`).
    /// `available == false` when the connection isn't an account session.
    struct QuotaStatus: Decodable, Equatable {
        var available: Bool
        var tier: String?
        var windowMicroUSD: Int?
        var spentMicroUSD: Int?
        var remainingMicroUSD: Int?
        var paidMicroUSD: Int?
        /// Unspent one-time welcome credit (standard models only); absent on older servers.
        var grantMicroUSD: Int?
        var resetAt: Double?
    }

    func billingQuota() async throws -> QuotaStatus {
        try await decode("/api/billing/quota", as: QuotaStatus.self)
    }

    /// Submit a StoreKit 2 transaction JWS for crediting (`POST /api/billing/iap`).
    /// `ok:false` with error "duplicate_transaction" still means the credit
    /// happened once already — the caller should finish() the transaction.
    struct IapResult: Decodable {
        var ok: Bool
        var creditedMicroUSD: Int?
        var error: String?
        var message: String?

        /// Codes the server will refuse on every retry: re-submitting can't help,
        /// so the user needs support, not "it will be credited automatically" (#486).
        static let permanentErrors: Set<String> = [
            "malformed_jws", "unbound_transaction", "wrong_account", "bad_chain",
            "unknown_product", "sandbox_rejected",
        ]
        var isPermanentFailure: Bool { !ok && Self.permanentErrors.contains(error ?? "") }
    }

    func iapSubmit(jws: String) async throws -> IapResult {
        var r: IapResult
        do {
            r = try await decode("/api/billing/iap", method: "POST", json: ["jws": jws], as: IapResult.self)
        } catch LisaError.server(let failure) where (400..<500).contains(failure.status) && !failure.code.isEmpty {
            // A typed refusal is an answer, not a transport failure.
            r = IapResult(ok: false, creditedMicroUSD: nil, error: failure.code, message: failure.message)
        }
        if r.error == "duplicate_transaction" { r.ok = true }
        return r
    }

    /// In-app account deletion (App Store 5.1.1(v)) — `DELETE /api/account`.
    /// Only works when the connection uses an account session.
    struct AccountDeletion: Decodable {
        let ok: Bool
        let requiresManualAppleRevocation: Bool?
    }

    func deleteAccount() async throws -> AccountDeletion {
        let result = try await decode("/api/account", method: "DELETE", as: AccountDeletion.self)
        guard result.ok else { throw LisaError.decode }
        return result
    }

    /// Re-send the email-verification mail (`POST /api/auth/verify/resend`).
    /// Returns true when a mail actually went out.
    func resendVerification() async throws -> Bool {
        struct R: Decodable { let ok: Bool; let sent: Bool?; let alreadyVerified: Bool? }
        let r = try await decode("/api/auth/verify/resend", method: "POST", as: R.self)
        return r.sent ?? (r.alreadyVerified ?? false)
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
        do {
            let (data, resp) = try await data(for: req, path: path)
            try LisaAPICompatibility.validate(resp)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            guard (200..<300).contains(code) else { throw LisaError.server(.from(resp, body: data)) }
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch { throw LisaError.decode }
        } catch {
            ConnectionLog.note("\(method) \(Self.logPath(path))", error)
            throw error
        }
    }

    /// The path without its query, for the diagnostics log.
    private static func logPath(_ path: String) -> String {
        String(path.split(separator: "?", maxSplits: 1).first ?? "")
    }

    /// Fire a mutating request and return the HTTP status (plus the server's
    /// refusal) WITHOUT throwing on a non-2xx — for the few call sites that branch
    /// on a specific answer (PTY off, session live, remote adoption disabled).
    /// Like `fireCode`, plus what the server said when it refused.
    private func fireResult(_ path: String, method: String = "POST", json: [String: Any]? = nil) async throws -> (status: Int, failure: ServerFailure?) {
        let req = try makeRequest(path, method: method, json: json, timeout: Self.restTimeout)
        do {
            let (data, resp) = try await data(for: req, path: path)
            try LisaAPICompatibility.validate(resp)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if (200..<300).contains(status) { return (status, nil) }
            let failure = ServerFailure.from(resp, body: data)
            ConnectionLog.note("\(method) \(Self.logPath(path))", LisaError.server(failure))
            return (status, failure)
        } catch {
            ConnectionLog.note("\(method) \(Self.logPath(path))", error)
            throw error
        }
    }

    /// Fire a mutating request that MUST succeed; throws `LisaError.http(code)` on
    /// any non-2xx so control/mutation actions never fail silently (the #1 review
    /// finding — a remote phone blocked by the control policy got 403 on every tap
    /// with zero feedback). This is the default for all the action methods below.
    private func fire(_ path: String, method: String = "POST", json: [String: Any]? = nil) async throws {
        let result = try await fireResult(path, method: method, json: json)
        if let failure = result.failure { throw LisaError.server(failure) }
    }

    /// This connection's AI recipients (`GET /api/auth/config`), fetched over the
    /// same transport as the send it gates — a relay-paired Mac has no base URL
    /// of its own (`<id>.lisa.invalid`), so the static `authConfig` can't reach it.
    func aiDisclosure() async throws -> AuthConfig.DataProcessing? {
        try await decode("/api/auth/config", as: AuthConfig.self).dataProcessing
    }

    // ── read ──
    func sessions() async throws -> [AgentSession] { try await decode("/api/agents/sessions", as: SessionsResponse.self).sessions }
    /// Lisa's own chat sessions — the roster's LISA group (v1.1).
    func lisaSessions() async throws -> [LisaSessionInfo] { try await decode("/api/sessions", as: LisaSessionsResponse.self).sessions }
    /// Switch the Mac's active web session (the Chat tab follows it).
    func activateSession(_ id: String) async throws -> LisaSessionMutation {
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await decode("/api/sessions/\(enc)/activate", method: "POST", as: LisaSessionMutation.self)
    }
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
    func managedApprove(_ id: String, allow: Bool, approvalId: String?) async throws {
        var body: [String: Any] = ["allow": allow]
        if let approvalId { body["approvalId"] = approvalId }
        try await fire("/api/agents/managed/\(id)/approve", json: body)
    }

    // ── control: PTY agents ──
    /// Spawn a fresh real CLI under a PTY (agent = "claude" | "codex"). Returns
    /// the HTTP status and, when refused, the server's reason: `pty_disabled`,
    /// `cli_missing` or `spawn_failed` on current Macs (#489).
    func ptyStart(agent: String, task: String) async throws -> (status: Int, failure: ServerFailure?) {
        try await fireResult("/api/agents/pty/start", json: ["agent": agent, "task": task])
    }
    func ptySend(_ id: String, _ text: String) async throws { try await fire("/api/agents/pty/\(id)/send", json: ["text": text]) }
    func ptyCancel(_ id: String) async throws { try await fire("/api/agents/pty/\(id)/cancel") }
    func ptyOutput(_ id: String) async throws -> String {
        struct R: Codable { var ok: Bool; var output: String? }
        return (try await decode("/api/agents/pty/\(id)/output", as: R.self)).output ?? ""
    }
    /// Live attach: a `snapshot` frame with the current tail, then a `chunk` per
    /// burst, then `end` when the agent finishes. Same control gate as send/cancel,
    /// so a Mac with remote control off answers 403.
    func ptyStream(_ id: String) -> AsyncThrowingStream<SSEMessage, Error> {
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return sse("/api/agents/pty/\(enc)/stream")
    }
    /// Adopt an idle claude session by id (resume-adopt). Returns the HTTP code
    /// (409 ⇒ the session is still live; 403 ⇒ remote adoption disabled).
    func adopt(sessionId: String) async throws -> (status: Int, failure: ServerFailure?) {
        try await fireResult("/api/agents/pty/start", json: ["agent": "claude", "resumeSessionId": sessionId])
    }

    // ── push ──
    /// Register (token non-empty) a Live Activity push token for a session.
    func registerLiveActivity(sessionId: String, token: String) async throws {
        try await fire("/api/push/live-activity", json: ["sessionId": sessionId, "token": token])
    }
    /// Register a delivery destination and return what the server stored — the
    /// caller needs the subscription id to update prefs later without
    /// re-registering.
    @discardableResult
    func pushRegister(kind: String, target: String, server: String? = nil,
                      prefs: PushPrefs) async throws -> PushSubscriptionDTO? {
        struct R: Codable { var ok: Bool?; var subscription: PushSubscriptionDTO? }
        var body: [String: Any] = ["kind": kind, "target": target, "prefs": prefs.json]
        if let server, !server.isEmpty { body["server"] = server }
        return (try await decode("/api/push/register", method: "POST", json: body, as: R.self)).subscription
    }

    /// Every destination the Mac will publish to — the honest basis for the
    /// "is push actually wired up" line in Settings.
    func pushList() async throws -> [PushSubscriptionDTO] {
        try await decode("/api/push/list", as: PushListResponse.self).subscriptions
    }

    /// Change the event toggles on an existing subscription (no re-register, so a
    /// registered APNs token isn't churned just to turn off advisor tips).
    func pushSetPrefs(id: String, prefs: PushPrefs) async throws {
        try await fire("/api/push/prefs", json: ["id": id, "prefs": prefs.json])
    }

    func pushUnregister(id: String) async throws {
        try await fire("/api/push/unregister", json: ["id": id])
    }

    // ── chat ──
    func expressionPreferences() async throws -> ExpressionPreferences {
        try await decode("/api/expressions/preferences", as: ExpressionPreferences.self)
    }
    func setExpressionPreferences(_ prefs: ExpressionPreferences) async throws -> ExpressionPreferences {
        try await decode("/api/expressions/preferences", method: "PUT", json: prefs.json, as: ExpressionPreferences.self)
    }
    func history(page: Int = 0) async throws -> HistoryResponse {
        try await decode("/api/history?page=\(page)", as: HistoryResponse.self)
    }
    func chatStream(_ message: String) -> AsyncThrowingStream<SSEMessage, Error> {
        sse("/chat", method: "POST", json: ["message": message, "expressions": true])
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
                    if let remote {
                        try await remote.stream(path: path, method: method, body: req.httpBody) { continuation.yield($0) }
                        continuation.finish()
                        return
                    }
                    let (bytes, resp) = try await session.bytes(for: req)
                    try LisaAPICompatibility.validate(resp)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                    guard (200..<300).contains(code) else {
                        // Read the (small) refusal body so the error carries its code.
                        var body = Data()
                        for try await byte in bytes {
                            body.append(byte)
                            if body.count > 8192 { break }
                        }
                        let failure = LisaError.server(.from(resp, body: body))
                        ConnectionLog.note("\(method) \(Self.logPath(path))", failure)
                        continuation.finish(throwing: failure)
                        return
                    }
                    captureRenewal(resp)
                    var decoder = SSEDecoder()
                    // Foundation's AsyncLineSequence skips empty lines, but
                    // those lines are the event boundaries in SSE.
                    for try await byte in bytes {
                        if let message = decoder.append(byte) { continuation.yield(message) }
                    }
                    continuation.finish()
                } catch {
                    if !(error is LisaError) { ConnectionLog.note("\(method) \(Self.logPath(path))", error) }
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Incremental SSE framing. Decode UTF-8 only after the complete line arrives;
/// preserve blank lines and accept LF, CRLF, or CR without double-dispatching.
struct SSEDecoder {
    private var line: [UInt8] = []
    private var dataLines: [String] = []
    private var skipLF = false

    mutating func append(_ byte: UInt8) -> SSEMessage? {
        if byte == 10 {
            if skipLF { skipLF = false; return nil }
            return finishLine()
        }
        if byte == 13 {
            skipLF = true
            return finishLine()
        }
        skipLF = false
        line.append(byte)
        return nil
    }

    private mutating func finishLine() -> SSEMessage? {
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        if text.isEmpty {
            defer { dataLines.removeAll(keepingCapacity: true) }
            guard !dataLines.isEmpty else { return nil }
            return SSEMessage(json: dataLines.joined(separator: "\n"))
        }
        if text.hasPrefix("data:") {
            dataLines.append(String(text.dropFirst(text.hasPrefix("data: ") ? 6 : 5)))
        }
        return nil
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
