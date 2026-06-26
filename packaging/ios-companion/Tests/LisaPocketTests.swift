import XCTest
@testable import LisaPocket

/// Logic tests for the pure helpers — no network, no Keychain, no app launch.
final class LisaPocketTests: XCTestCase {

    private func session(_ state: String, id: String = "s", agent: String = "claude-code",
                         pending: String? = nil, mtime: String? = nil) -> AgentSession {
        let activity = pending.map {
            SessionActivity(turnCount: nil, lastTools: nil, filesTouched: nil, lastCommandName: nil,
                            lastError: nil, gitBranch: nil, tokens: nil, pendingPermission: $0)
        }
        return AgentSession(agent: agent, sessionId: id, project: "p", cwd: nil, state: state,
                            stateReason: "", lastMtime: mtime, activity: activity, controllable: nil,
                            resumable: nil, adoptedSessionId: nil)
    }

    // ── rosterCounts: each session lands in exactly one bucket ──
    func testRosterCountsBuckets() {
        let snap = rosterCounts([
            session("working", id: "a"),
            session("working", id: "b"),
            session("waiting", id: "c"),
            session("error", id: "d"),
            session("working", id: "e", pending: "Bash"),  // pending ⇒ waiting bucket
            session("done", id: "f"),
        ], at: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(snap.working, 2)
        XCTAssertEqual(snap.waiting, 2)   // one "waiting" + one pending-permission
        XCTAssertEqual(snap.error, 1)
        XCTAssertEqual(snap.total, 6)     // done counts toward total only
        XCTAssertEqual(snap.stuck, 3)     // waiting + error
    }

    func testRosterCountsEmpty() {
        let snap = rosterCounts([], at: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(snap.total, 0)
        XCTAssertEqual(snap.stuck, 0)
    }

    // ── sortRows: pending-permission first, then error, waiting, working ──
    func testSortRowsRanking() {
        let sorted = sortRows([
            session("working", id: "w"),
            session("done", id: "d"),
            session("error", id: "e"),
            session("working", id: "p", pending: "Bash"),
            session("waiting", id: "wa"),
        ])
        XCTAssertEqual(sorted.map(\.sessionId), ["p", "e", "wa", "w", "d"])
    }

    // ── parseDeepLink ──
    func testParseDeepLinkSession() {
        XCTAssertEqual(AppState.parseDeepLink(URL(string: "lisapocket://session?agent=codex&id=s9")!),
                       .session(agent: "codex", id: "s9"))
    }
    func testParseDeepLinkRoster() {
        XCTAssertEqual(AppState.parseDeepLink(URL(string: "lisapocket://roster")!), .roster)
    }
    func testParseDeepLinkUnknownHostFallsBackToRoster() {
        XCTAssertEqual(AppState.parseDeepLink(URL(string: "lisapocket://whatever")!), .roster)
    }
    func testParseDeepLinkSessionMissingParamsFallsBackToRoster() {
        XCTAssertEqual(AppState.parseDeepLink(URL(string: "lisapocket://session?agent=codex")!), .roster)
    }
    func testParseDeepLinkIgnoresForeignScheme() {
        XCTAssertEqual(AppState.parseDeepLink(URL(string: "https://example.com")!), .ignore)
    }

    // ── parsePairing: LAN http, cloud https, lisa-pair:// ──
    func testParsePairingCloudHTTPS() {
        let cfg = AppState.parsePairing("https://lisa-cloud-xxx.run.app/?token=abc")
        XCTAssertEqual(cfg, ServerConfig(host: "lisa-cloud-xxx.run.app", port: 443, token: "abc", scheme: "https"))
        // baseURL drops the default :443 → a clean cloud URL.
        XCTAssertEqual(cfg?.baseURL?.absoluteString, "https://lisa-cloud-xxx.run.app")
    }
    func testParsePairingLANHTTP() {
        let cfg = AppState.parsePairing("http://192.168.3.162:5757/?token=abc")
        XCTAssertEqual(cfg, ServerConfig(host: "192.168.3.162", port: 5757, token: "abc", scheme: "http"))
        XCTAssertEqual(cfg?.baseURL?.absoluteString, "http://192.168.3.162:5757")
    }
    func testParsePairingLisaPairWithScheme() {
        let cfg = AppState.parsePairing("lisa-pair://v1?host=lisa-cloud.run.app&port=443&token=abc&scheme=https")
        XCTAssertEqual(cfg, ServerConfig(host: "lisa-cloud.run.app", port: 443, token: "abc", scheme: "https"))
    }
    func testParsePairingLisaPairDefaultsToLAN() {
        let cfg = AppState.parsePairing("lisa-pair://v1?host=mac.local&token=abc")
        XCTAssertEqual(cfg, ServerConfig(host: "mac.local", port: 5757, token: "abc", scheme: "http"))
    }
    func testParsePairingRejectsMissingToken() {
        XCTAssertNil(AppState.parsePairing("https://lisa-cloud.run.app/"))
    }

    // ── AgentSession.lastMtime tolerates both shapes (regression for the SSE bug) ──
    func testDecodesNumericLastMtimeFromSSE() throws {
        // agent_session_update broadcasts raw epoch-ms; must not throw.
        let json = #"{"agent":"codex","sessionId":"s1","project":"p","state":"working","stateReason":"","lastMtime":1718800000000,"activity":{"pendingPermission":"Bash"}}"#
        let s = try JSONDecoder().decode(AgentSession.self, from: Data(json.utf8))
        XCTAssertEqual(s.agent, "codex")
        XCTAssertNotNil(s.lastMtime)                 // number normalized to a string
        XCTAssertFalse(s.lastMtime!.isEmpty)
        XCTAssertEqual(s.activity?.pendingPermission, "Bash")
    }
    func testDecodesIsoLastMtimeFromREST() throws {
        let json = #"{"agent":"claude-code","sessionId":"s2","project":"p","state":"done","stateReason":"","lastMtime":"2026-06-19T10:00:00.000Z"}"#
        let s = try JSONDecoder().decode(AgentSession.self, from: Data(json.utf8))
        XCTAssertEqual(s.lastMtime, "2026-06-19T10:00:00.000Z")
    }
    func testDecodesMissingLastMtime() throws {
        let json = #"{"agent":"aider","sessionId":"s3","project":"p","state":"idle","stateReason":""}"#
        let s = try JSONDecoder().decode(AgentSession.self, from: Data(json.utf8))
        XCTAssertNil(s.lastMtime)
    }
}
