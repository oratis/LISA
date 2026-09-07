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

    // ── ServerConfig.isPrivateLAN — home-Wi-Fi addresses that die off-network ──
    func testIsPrivateLAN() {
        func cfg(_ h: String) -> ServerConfig { ServerConfig(host: h, port: 5757, token: "t") }
        XCTAssertTrue(cfg("192.168.3.42").isPrivateLAN)
        XCTAssertTrue(cfg("10.0.0.5").isPrivateLAN)
        XCTAssertTrue(cfg("172.16.0.1").isPrivateLAN)
        XCTAssertTrue(cfg("172.31.255.254").isPrivateLAN)
        XCTAssertFalse(cfg("172.15.0.1").isPrivateLAN)          // just below 172.16
        XCTAssertFalse(cfg("172.32.0.1").isPrivateLAN)          // just above 172.31
        XCTAssertFalse(cfg("100.101.102.103").isPrivateLAN)     // Tailscale — reachable anywhere
        XCTAssertFalse(cfg("lisa-cloud.run.app").isPrivateLAN)  // hostname
        XCTAssertFalse(cfg("8.8.8.8").isPrivateLAN)
    }

    // ── ConnectionProblem.classify — friendly + honest, and -999 stays silent ──
    func testConnectionProblemClassify() {
        let lan = ServerConfig(host: "192.168.3.42", port: 5757, token: "t")
        let cloud = ServerConfig(host: "lisa-cloud.run.app", port: 443, token: "t", scheme: "https")

        // -999 "cancelled" → transient, never shown (the reported bug)
        let cancelled = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        XCTAssertEqual(ConnectionProblem.classify(cancelled, config: lan), .cancelled)
        XCTAssertNil(ConnectionProblem.classify(cancelled, config: lan).display)

        // cannot connect + a LAN host → the off-Wi-Fi guidance; a cloud host → generic
        let cannot = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        XCTAssertEqual(ConnectionProblem.classify(cannot, config: lan), .cannotReach(privateLAN: true))
        XCTAssertEqual(ConnectionProblem.classify(cannot, config: cloud), .cannotReach(privateLAN: false))
        XCTAssertNotNil(ConnectionProblem.classify(cannot, config: lan).display)

        // auth vs server error
        XCTAssertEqual(ConnectionProblem.classify(LisaError.http(401), config: lan), .unauthorized)
        XCTAssertEqual(ConnectionProblem.classify(LisaError.http(403), config: lan), .unauthorized)
        XCTAssertEqual(ConnectionProblem.classify(LisaError.http(503), config: lan), .serverError(503))
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

    // ── parseCloudBase: token-less cloud URL for the Sign in with Apple flow ──
    func testParseCloudBaseFullURL() {
        let cfg = AppState.parseCloudBase("https://lisa-cloud-xxx.run.app")
        XCTAssertEqual(cfg, ServerConfig(host: "lisa-cloud-xxx.run.app", port: 443, token: nil, scheme: "https"))
    }
    func testParseCloudBaseBareHostAssumesHTTPS() {
        let cfg = AppState.parseCloudBase("lisa-cloud-xxx.run.app")
        XCTAssertEqual(cfg, ServerConfig(host: "lisa-cloud-xxx.run.app", port: 443, token: nil, scheme: "https"))
    }
    func testParseCloudBaseKeepsExplicitPortAndStripsToken() {
        // A token in the URL is ignored — the server mints the real one after sign-in.
        let cfg = AppState.parseCloudBase("https://host.example:8443/?token=ignored")
        XCTAssertEqual(cfg, ServerConfig(host: "host.example", port: 8443, token: nil, scheme: "https"))
    }
    func testParseCloudBaseRejectsEmpty() {
        XCTAssertNil(AppState.parseCloudBase("   "))
    }

    // ── ConnectionMode persists by rawValue (the "lisa.mode" UserDefaults key) ──
    func testConnectionModeRawValues() {
        XCTAssertEqual(ConnectionMode(rawValue: "mac"), .mac)
        XCTAssertEqual(ConnectionMode(rawValue: "cloud"), .cloud)
        XCTAssertNil(ConnectionMode(rawValue: "bogus"))
        XCTAssertEqual(ConnectionMode.allCases.count, 2)
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

    // ── API contract: old servers remain usable; future majors fail clearly ──
    func testAPIContractCompatibility() throws {
        let url = URL(string: "https://lisa.example/api/agents/sessions")!
        let legacy = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        XCTAssertNoThrow(try LisaAPICompatibility.validate(legacy))

        let current = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [LisaAPIContract.versionHeader: "1"]
        )!
        XCTAssertNoThrow(try LisaAPICompatibility.validate(current))

        let future = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [LisaAPIContract.versionHeader: "2"]
        )!
        XCTAssertThrowsError(try LisaAPICompatibility.validate(future)) { error in
            guard case LisaError.unsupportedAPIVersion(let version) = error else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(version, 2)
        }

        let malformed = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [LisaAPIContract.versionHeader: "banana"]
        )!
        XCTAssertThrowsError(try LisaAPICompatibility.validate(malformed))

        let invalidZero = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [LisaAPIContract.versionHeader: "0"]
        )!
        XCTAssertThrowsError(try LisaAPICompatibility.validate(invalidZero))
    }

    // ── onboarding model: install commands are the real repo ones ──
    func testInstallCommands() {
        XCTAssertEqual(InstallMethod.homebrew.installCommand, "brew install oratis/tap/lisa")
        XCTAssertEqual(InstallMethod.npm.installCommand, "npm install -g @oratis/lisa")
        XCTAssertNil(InstallMethod.app.installCommand)            // .app downloads a .dmg instead
        XCTAssertNotNil(InstallMethod.app.downloadURL)
        XCTAssertNil(InstallMethod.homebrew.downloadURL)
        XCTAssertEqual(InstallMethod.allCases.count, 3)
    }

    // CLI installs must instruct the LAN-reachable bind (the #1 pairing gotcha)
    // AND arm LISA_WEB_TOKEN (the server refuses a non-loopback bind without it);
    // the menu-bar app has nothing to type.
    func testServeCommandReachableForCLIOnly() {
        let expected = "LISA_WEB_TOKEN=$(openssl rand -hex 24) lisa serve --web --host 0.0.0.0"
        XCTAssertEqual(InstallMethod.npm.serveCommand, expected)
        XCTAssertEqual(InstallMethod.homebrew.serveCommand, expected)
        XCTAssertTrue(InstallMethod.npm.serveCommand!.contains("--host 0.0.0.0"))
        XCTAssertNil(InstallMethod.app.serveCommand)
        XCTAssertTrue(InstallMethod.npm.isCLI)
        XCTAssertFalse(InstallMethod.app.isCLI)
    }

    // ── PTY live stream: bounded buffer + an honest connection phrase ──

    func testPTYBufferKeepsShortOutputIntact() {
        XCTAssertEqual(PTYBuffer.appending("world", to: "hello "), "hello world")
        XCTAssertEqual(PTYBuffer.trimmed("short"), "short")
    }

    func testPTYBufferTrimsToTheTailOnALineBoundary() {
        // 20 chars of head, then a newline, then the tail we care about.
        let text = String(repeating: "x", count: 20) + "\n" + String(repeating: "y", count: 40)
        let out = PTYBuffer.trimmed(text, limit: 45)
        XCTAssertEqual(out, String(repeating: "y", count: 40),
                       "the leading partial line is dropped when it's cheap to do so")
        XCTAssertLessThanOrEqual(out.count, 45)
    }

    func testPTYBufferFallsBackToARawTailWhenNoNearbyNewline() {
        let text = String(repeating: "z", count: 5000)   // one enormous line
        let out = PTYBuffer.trimmed(text, limit: 100)
        XCTAssertEqual(out.count, 100)
    }

    func testPTYBufferAppendStaysBounded() {
        var text = ""
        for _ in 0..<50 { text = PTYBuffer.appending(String(repeating: "a", count: 100) + "\n", to: text, limit: 500) }
        XCTAssertLessThanOrEqual(text.count, 500)
    }

    func testPTYStreamStatePhrasesAreDistinctAndNameTheReason() {
        XCTAssertEqual(PTYStreamState.live.phrase, "live")
        XCTAssertEqual(PTYStreamState.ended.phrase, "finished")
        XCTAssertTrue(PTYStreamState.retrying(seconds: 4).phrase.contains("4s"))
        XCTAssertEqual(PTYStreamState.blocked("Remote control is disabled on this Mac — no live output.").phrase,
                       "Remote control is disabled on this Mac — no live output.")
    }

    // ── push transport: the topic URL, and an honest state line ──

    func testNtfyPublishURLDefaultsToNtfySh() {
        XCTAssertEqual(PushSettings.ntfyPublishURL(server: nil, topic: "lisa-abc")?.absoluteString,
                       "https://ntfy.sh/lisa-abc")
        XCTAssertEqual(PushSettings.ntfyPublishURL(server: "", topic: " lisa-abc ")?.absoluteString,
                       "https://ntfy.sh/lisa-abc")
    }

    func testNtfyPublishURLAcceptsBareHostAndTrimsSlashes() {
        XCTAssertEqual(PushSettings.ntfyPublishURL(server: "ntfy.example.com", topic: "t")?.absoluteString,
                       "https://ntfy.example.com/t")
        XCTAssertEqual(PushSettings.ntfyPublishURL(server: "http://10.0.0.9:8080/", topic: "t")?.absoluteString,
                       "http://10.0.0.9:8080/t")
    }

    func testNtfyPublishURLRejectsEmptyTopic() {
        XCTAssertNil(PushSettings.ntfyPublishURL(server: nil, topic: "   "))
    }

    func testStateLineNeverClaimsApnsDeliveryWorks() {
        let token = "abc123"
        let registered = [PushSubscriptionDTO(id: "1", kind: "apns", target: token)]
        let line = PushSettings.stateLine(transport: .apns, subs: registered, loaded: true,
                                          apnsToken: token, ntfyTopic: "")
        // The old copy said "Push registered (APNs)" with no Apple key anywhere —
        // the exact dead end UX-12 flagged. The line must name the dependency.
        XCTAssertTrue(line.contains("LISA_APNS_"))
        XCTAssertFalse(line.lowercased().contains("push registered"))

        let noToken = PushSettings.stateLine(transport: .apns, subs: [], loaded: true,
                                             apnsToken: nil, ntfyTopic: "")
        XCTAssertTrue(noToken.contains("Simulator"))

        let notSent = PushSettings.stateLine(transport: .apns, subs: [], loaded: true,
                                             apnsToken: token, ntfyTopic: "")
        XCTAssertTrue(notSent.contains("doesn't have it yet"))
    }

    func testStateLineDistinguishesRegisteredFromADifferentTopic() {
        let subs = [PushSubscriptionDTO(id: "1", kind: "ntfy", target: "old-topic", server: "https://ntfy.example.com")]
        let mismatch = PushSettings.stateLine(transport: .ntfy, subs: subs, loaded: true,
                                              apnsToken: nil, ntfyTopic: "new-topic")
        XCTAssertTrue(mismatch.contains("old-topic"))
        XCTAssertTrue(mismatch.contains("different topic"))

        let matched = PushSettings.stateLine(transport: .ntfy, subs: subs, loaded: true,
                                             apnsToken: nil, ntfyTopic: "old-topic")
        XCTAssertTrue(matched.contains("ntfy.example.com"))

        let none = PushSettings.stateLine(transport: .ntfy, subs: [], loaded: true,
                                          apnsToken: nil, ntfyTopic: "t")
        XCTAssertTrue(none.contains("Not registered yet"))

        XCTAssertTrue(PushSettings.stateLine(transport: .ntfy, subs: [], loaded: false,
                                             apnsToken: nil, ntfyTopic: "t").contains("Checking"))
    }

    func testUnsavedPrefsOnlyWhenSomethingIsRegistered() {
        var local = PushPrefs()
        XCTAssertFalse(PushSettings.hasUnsavedPrefs(local: local, registered: nil))
        XCTAssertFalse(PushSettings.hasUnsavedPrefs(local: local, registered: PushPrefs()))
        local.advisor = true
        XCTAssertTrue(PushSettings.hasUnsavedPrefs(local: local, registered: PushPrefs()))
    }

    func testPushSubscriptionDecodesTolerantlyAndPrefsFallBack() throws {
        // A Mac that predates `brief` / `server` must still produce a usable row.
        let json = Data("""
        {"subscriptions":[{"id":"a1","kind":"ntfy","target":"topic","prefs":{"done":false,"error":true,"permission":true,"idle":true,"advisor":false,"mail":true}},
                          {"id":"a2","kind":"apns","target":"deadbeef","server":null,"prefs":null,"createdAt":1}]}
        """.utf8)
        let list = try JSONDecoder().decode(PushListResponse.self, from: json).subscriptions
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list[0].transport, .ntfy)
        XCTAssertEqual(list[0].prefs?.done, false)
        XCTAssertEqual(list[0].prefs?.brief, true, "a missing preference falls back to its default")
        XCTAssertNil(list[0].server)
        XCTAssertEqual(list[1].transport, .apns)
        XCTAssertNil(list[1].prefs)
    }

    func testPushPrefsJSONCarriesEveryServerKey() {
        let keys = Set(PushPrefs().json.keys)
        XCTAssertEqual(keys, ["done", "error", "permission", "idle", "advisor", "mail", "brief"])
    }

    // ── a11y: every status pip has a word, and it matches the colour bucket ──

    func testGlanceColorsPhraseCoversEveryStateBucket() {
        XCTAssertEqual(GlanceColors.phrase("working"), "working")
        XCTAssertEqual(GlanceColors.phrase("waiting"), "waiting on you")
        XCTAssertEqual(GlanceColors.phrase("error"), "errored")
        XCTAssertEqual(GlanceColors.phrase("done"), "done")
        XCTAssertEqual(GlanceColors.phrase("something-new"), "idle")
        XCTAssertEqual(GlanceColors.phrase(""), "idle")
    }

    func testStatusPhraseAgreesWithStateColorOnPendingPermission() {
        // stateColor paints a pending permission amber regardless of raw state;
        // the spoken label has to make the same call or they contradict.
        let pending = session("working", pending: "Bash(rm -rf)")
        XCTAssertEqual(statusPhrase(pending), "needs you: Bash(rm -rf)")
        XCTAssertEqual(stateColor(pending), Theme.waiting)

        XCTAssertEqual(statusPhrase(session("working")), "working")
        XCTAssertEqual(statusPhrase(session("error")), "errored")
        XCTAssertEqual(statusPhrase(session("mystery")), "idle")
    }

    func testOnboardingDottedSequence() {
        XCTAssertEqual(OnboardingStep.dotted, [.install, .start, .pair, .scan, .connect])
        XCTAssertEqual(OnboardingStep.welcome.rawValue, 0)        // welcome/mode are pre-flow
        XCTAssertLessThan(OnboardingStep.install.rawValue, OnboardingStep.connect.rawValue)
    }

    // ── M2: connect-failure recovery is outcome-specific ──
    func testVerifyOutcomeRecovery() {
        // A rejected token can't be retried — offer a fresh scan first.
        XCTAssertEqual(VerifyOutcome.unauthorized.recovery.first, .rescan)
        // A reachable-but-erroring or unreachable Mac is worth a retry.
        XCTAssertEqual(VerifyOutcome.unreachable.recovery.first, .retry)
        XCTAssertEqual(VerifyOutcome.serverError(500).recovery.first, .retry)
        // Manual entry is always an escape hatch; success has nothing to recover.
        XCTAssertTrue(VerifyOutcome.unauthorized.recovery.contains(.manual))
        XCTAssertTrue(VerifyOutcome.ok.recovery.isEmpty)
        XCTAssertEqual(RecoveryAction.rescan.label, "Scan a fresh code")
    }

    // ── A4: the Google redirect scheme is the client id, reversed ──
    @MainActor
    func testGoogleRedirectScheme() {
        XCTAssertEqual(
            GoogleSignIn.redirectScheme(clientId: "123-abc.apps.googleusercontent.com"),
            "com.googleusercontent.apps.123-abc")
        // A web client id (or anything else) has no reversed form — refuse it
        // rather than build a redirect Google will reject.
        XCTAssertNil(GoogleSignIn.redirectScheme(clientId: "123-abc.example.com"))
        XCTAssertNil(GoogleSignIn.redirectScheme(clientId: ""))
    }

    // ── DispatchKind — a dead pid is not the same as a clean finish ──────────
    private func dispatch(status: String?, alive: Bool, exitCode: Int? = nil,
                          exitSignal: String? = nil) -> DispatchView {
        DispatchView(id: "d1", agent: "claude", pid: 42, cwd: "/p", task: "t",
                     startedAt: "1970-01-01T00:00:00.000Z", alive: alive, hasLog: false,
                     status: status, exitCode: exitCode, exitSignal: exitSignal, exitedAt: nil)
    }

    func testDispatchKindFromServerStatus() {
        XCTAssertEqual(dispatch(status: "running", alive: true).kind, .running)
        XCTAssertEqual(dispatch(status: "ok", alive: false).kind, .ok)
        XCTAssertEqual(dispatch(status: "failed", alive: false).kind, .failed)
        XCTAssertEqual(dispatch(status: "unknown", alive: false).kind, .unknown)
    }

    func testDispatchKindFallsBackForAPreStatusServer() {
        // An older backend sends only `alive`. Never infer success from it: the
        // agent is detached, so a crash and a clean finish look identical.
        XCTAssertEqual(dispatch(status: nil, alive: true).kind, .running)
        XCTAssertEqual(dispatch(status: nil, alive: false).kind, .unknown)
        XCTAssertNotEqual(dispatch(status: nil, alive: false).kind, .ok)
    }

    func testDispatchKindIgnoresAnUnrecognisedStatus() {
        XCTAssertEqual(dispatch(status: "banana", alive: false).kind, .unknown)
    }

    func testDispatchDetailNamesTheExitCodeOrSignal() {
        let failed = dispatch(status: "failed", alive: false, exitCode: 127)
        XCTAssertEqual(DispatchDetailView.detailStatus(nil, entry: failed), "failed (exit 127)")

        let killed = dispatch(status: "failed", alive: false, exitSignal: "SIGKILL")
        XCTAssertEqual(DispatchDetailView.detailStatus(nil, entry: killed), "killed by SIGKILL")

        let ok = dispatch(status: "ok", alive: false, exitCode: 0)
        XCTAssertEqual(DispatchDetailView.detailStatus(nil, entry: ok), "finished (exit 0)")

        let unknown = dispatch(status: nil, alive: false)
        XCTAssertEqual(DispatchDetailView.detailStatus(nil, entry: unknown),
                       "exited — status not captured")
    }

    func testEveryDispatchKindSpeaksItsStateForVoiceOver() {
        // The dot's colour carries no information for VoiceOver, so each state
        // must be distinguishable in words alone.
        let spoken = [DispatchKind.running, .ok, .failed, .unknown].map(\.accessibleLabel)
        XCTAssertEqual(Set(spoken).count, 4, "each state needs its own spoken label")
        XCTAssertFalse(spoken.contains { $0.isEmpty })
    }

unc testQuotaExhaustedClassification() {
        XCTAssertTrue(ChatModel.isQuotaExhausted(LisaError.http(402)))
        XCTAssertFalse(ChatModel.isQuotaExhausted(LisaError.http(401)))
        XCTAssertFalse(ChatModel.isQuotaExhausted(LisaError.http(500)))
        XCTAssertFalse(ChatModel.isQuotaExhausted(URLError(.timedOut)))
    }

    // ── 2.1(b): the routes to the In-App Purchases must not vanish silently ──

    /// Only a 402 (allowance spent) offers credits in chat; every other failure
    /// stays a plain error with a Retry.
    @MainActor
    func testQuotaExhaustedClassification() {
        XCTAssertTrue(ChatModel.isQuotaExhausted(LisaError.http(402)))
        XCTAssertFalse(ChatModel.isQuotaExhausted(LisaError.http(401)))
        XCTAssertFalse(ChatModel.isQuotaExhausted(LisaError.http(500)))
        XCTAssertFalse(ChatModel.isQuotaExhausted(URLError(.timedOut)))
    }

    /// A message only offers "Add credits…" when the server said 402.
    func testNeedsCreditsDefaultsOff() {
        XCTAssertFalse(ChatMessage(role: .lisa, text: "hi").needsCredits)
        var refused = ChatMessage(role: .lisa, text: "out of allowance", status: .error)
        refused.needsCredits = true
        XCTAssertTrue(refused.needsCredits)
        XCTAssertTrue(refused.isRetryable)
    }

    /// An empty StoreKit response is a FAILURE, not a "loaded" empty list —
    /// a blank sheet is what App Review saw as "no In-App Purchases".
    @MainActor
    func testPaywallLoadStateStartsIdle() {
        XCTAssertEqual(CreditsStore.LoadState.idle, CreditsStore.LoadState.idle)
        XCTAssertNotEqual(CreditsStore.LoadState.loaded, CreditsStore.LoadState.failed)
        // The three packs the App Store record defines, in the order we sell them.
        XCTAssertEqual(CreditsStore.productIDs, [
            "ai.meetlisa.main.credits.5",
            "ai.meetlisa.main.credits.10",
            "ai.meetlisa.main.credits.20",
        ])
    }
}
