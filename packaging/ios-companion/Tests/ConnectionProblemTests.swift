import XCTest
@testable import LisaPocket

/// The error vocabulary between LISA servers and Pocket (#487, #484–#486, #489,
/// #492): what each server answer means, and what the user is told to do.
final class ConnectionProblemTests: XCTestCase {
    private let lan = ServerConfig(host: "192.168.3.42", port: 5757, token: "0123abcd")

    /// A syntactically valid account session (the claims are what Pocket reads).
    private func session(uid: String = "alice", issued: Date, expires: Date) -> String {
        let claims = ["uid": uid, "iat": issued.timeIntervalSince1970 * 1000,
                      "exp": expires.timeIntervalSince1970 * 1000, "sv": 0] as [String: Any]
        let json = try! JSONSerialization.data(withJSONObject: claims)
        let payload = json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "s1.\(payload).signature"
    }

    private var cloud: ServerConfig {
        ServerConfig(host: "cloud.example", port: 443,
                     token: session(issued: Date(), expires: Date().addingTimeInterval(86_400)), scheme: "https")
    }

    private func failure(_ status: Int, _ json: String) -> LisaError {
        .server(ServerFailure(status: status, body: Data(json.utf8), contentType: "application/json"))
    }

    // ── ServerFailure parsing ──

    func testParsesJSONTextAndIgnoresHTML() {
        let json = ServerFailure(status: 429, body: Data(#"{"error":"otp_cooldown","message":" Wait. ","retryAfterSec":55}"#.utf8),
                                 contentType: "application/json; charset=utf-8")
        XCTAssertEqual(json.code, "otp_cooldown")
        XCTAssertEqual(json.message, "Wait.")
        XCTAssertEqual(json.retryAfterSec, 55)

        let unauthorized = ServerFailure(status: 401, body: Data(#"{"error":"unauthorized","reason":"token_mismatch"}"#.utf8))
        XCTAssertEqual(unauthorized.reason, "token_mismatch")
        XCTAssertNil(unauthorized.message)

        let text = ServerFailure(status: 403, body: Data("remote control is disabled for this device\n".utf8),
                                 contentType: "text/plain")
        XCTAssertEqual(text.message, "remote control is disabled for this device")

        let html = ServerFailure(status: 502, body: Data("<html>Bad gateway</html>".utf8), contentType: "text/html")
        XCTAssertNil(html.message)
        XCTAssertEqual(html.code, "")
    }

    func testErrorDescriptionPrefersTheServersSentence() {
        XCTAssertEqual(failure(403, #"{"error":"account_suspended","message":"This account is suspended."}"#).errorDescription,
                       "This account is suspended.")
        XCTAssertEqual(LisaError.server(ServerFailure(status: 500)).errorDescription, "Server returned HTTP 500.")
        XCTAssertEqual(failure(404, "{}").httpStatus, 404)
        XCTAssertEqual(LisaError.http(402).httpStatus, 402)
        XCTAssertNil(LisaError.decode.httpStatus)
    }

    // ── classification ──

    func testCodesWinOverStatus() {
        XCTAssertEqual(ConnectionProblem.classify(failure(400, #"{"error":"clock_skew"}"#), config: lan), .clockSkew)
        XCTAssertEqual(ConnectionProblem.classify(failure(403, #"{"error":"remote_control_disabled","message":"x"}"#), config: lan),
                       .remoteControlOff)
        XCTAssertEqual(ConnectionProblem.classify(failure(402, #"{"error":"service_paused"}"#), config: cloud), .servicePaused)
        XCTAssertEqual(ConnectionProblem.classify(failure(409, #"{"error":"turn_in_progress"}"#), config: cloud), .busy)
        XCTAssertEqual(ConnectionProblem.classify(failure(429, "{}"), config: cloud), .rateLimited)
        XCTAssertEqual(ConnectionProblem.classify(failure(403, #"{"error":"account_suspended","message":"Suspended."}"#), config: cloud),
                       .refused("Suspended."))
    }

    func testA401MeansSignInForAccountsAndRePairForDeviceTokens() {
        XCTAssertEqual(ConnectionProblem.classify(LisaError.http(401), config: cloud), .signInRequired)
        XCTAssertEqual(ConnectionProblem.classify(LisaError.http(401), config: lan), .unauthorized)
        var relay = ServerConfig(host: "abc.lisa.invalid", port: 443, token: nil, scheme: "https")
        relay.remoteMac = RemoteMacTarget(id: "abc", name: "Mac", publicKey: "k", cloudOrigin: "https://cloud.example", accountUID: "alice")
        XCTAssertEqual(ConnectionProblem.classify(LisaError.http(401), config: relay), .signInRequired)
        XCTAssertEqual(ConnectionProblem.classify(LisaError.http(401), config: relay).action, .signIn)
    }

    func testRelayErrorsSayWhatHappened() {
        XCTAssertEqual(ConnectionProblem.classify(RemoteLinkError.notAllowed, config: lan), .deviceRemoved)
        XCTAssertEqual(ConnectionProblem.classify(RemoteLinkError.signIn, config: lan), .signInRequired)
        XCTAssertEqual(ConnectionProblem.classify(RemoteLinkError.macOffline, config: lan), .macOffline)
        XCTAssertEqual(ConnectionProblem.classify(RemoteLinkError.interrupted, config: lan), .interrupted)
        XCTAssertEqual(ConnectionProblem.classify(RemoteLinkError.invalidPeer, config: lan), .pairAgain)
        XCTAssertEqual(ConnectionProblem.classify(LisaError.decode, config: lan), .badResponse)
        XCTAssertEqual(ConnectionProblem.classify(LisaError.unsupportedAPIVersion(3), config: lan), .updateRequired(3))
        // None of these tell a relay user to run `lisa serve --host 0.0.0.0`.
        for problem in [ConnectionProblem.deviceRemoved, .signInRequired, .macOffline, .clockSkew, .servicePaused] {
            XCTAssertFalse(problem.display?.message.contains("0.0.0.0") ?? true, "\(problem)")
        }
    }

    func testCloudOutageIsNotAMacProblem() {
        let offline = NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
        XCTAssertEqual(ConnectionProblem.classify(offline, config: cloud), .cloudUnreachable)
        XCTAssertEqual(ConnectionProblem.classify(offline, config: lan), .cannotReach(privateLAN: true))
        XCTAssertEqual(ConnectionProblem.classify(CancellationError(), config: cloud), .cancelled)
    }

    func testRelayUpgradeFailuresMapToCauses() {
        let raw = URLError(.badServerResponse)
        XCTAssertEqual(RemoteMacTransport.openFailure(raw, status: 403, closeCode: 0, timedOut: false) as? RemoteLinkError, .signIn)
        XCTAssertEqual(RemoteMacTransport.openFailure(raw, status: 503, closeCode: 0, timedOut: false) as? RemoteLinkError, .macOffline)
        XCTAssertEqual(RemoteMacTransport.openFailure(raw, status: nil, closeCode: 1013, timedOut: false) as? RemoteLinkError, .macOffline)
        XCTAssertEqual(RemoteMacTransport.openFailure(URLError(.cancelled), status: nil, closeCode: 0, timedOut: true) as? RemoteLinkError,
                       .macOffline)
        XCTAssertEqual((RemoteMacTransport.openFailure(raw, status: nil, closeCode: 0, timedOut: false) as? URLError)?.code,
                       .badServerResponse)
        XCTAssertTrue(RemoteMacTransport.openFailure(CancellationError(), status: 503, closeCode: 0, timedOut: true) is CancellationError)
    }

    func testACloudWithoutTheMacRelayIsNotASignInProblem() {
        XCTAssertTrue(MacConnectionsView.macConnectionsUnavailable(failure(403, #"{"error":"account_session_required","message":"Sign in to your Lisa account to do this."}"#)))
        XCTAssertTrue(MacConnectionsView.macConnectionsUnavailable(failure(403, #"{"error":"account_session_required"}"#)))
        XCTAssertTrue(MacConnectionsView.macConnectionsUnavailable(LisaError.http(403)))
        XCTAssertTrue(MacConnectionsView.macConnectionsUnavailable(LisaError.http(404)))
        XCTAssertFalse(MacConnectionsView.macConnectionsUnavailable(failure(403, #"{"error":"account_suspended","message":"Suspended."}"#)))
        XCTAssertFalse(MacConnectionsView.macConnectionsUnavailable(failure(401, #"{"error":"unauthorized"}"#)))
    }

    // ── billing ──

    @MainActor
    func testOnlyAllowanceAndPremiumAnswersOpenThePaywall() {
        XCTAssertTrue(ChatModel.isQuotaExhausted(failure(402, #"{"error":"quota_exhausted"}"#)))
        XCTAssertTrue(ChatModel.isQuotaExhausted(failure(402, #"{"error":"premium_requires_balance"}"#)))
        XCTAssertTrue(ChatModel.isQuotaExhausted(LisaError.http(402)), "an older server's bare 402 meant the allowance")
        XCTAssertFalse(ChatModel.isQuotaExhausted(failure(402, #"{"error":"service_paused"}"#)))
        XCTAssertFalse(ChatModel.isQuotaExhausted(failure(403, #"{"error":"quota_exhausted"}"#)))
    }

    func testPermanentPurchaseRefusals() {
        let refused = LisaClient.IapResult(ok: false, creditedMicroUSD: nil, error: "wrong_account")
        XCTAssertTrue(refused.isPermanentFailure)
        XCTAssertFalse(LisaClient.IapResult(ok: false, creditedMicroUSD: nil, error: "store_unavailable").isPermanentFailure)
        XCTAssertFalse(LisaClient.IapResult(ok: true, creditedMicroUSD: 1, error: nil).isPermanentFailure)
    }

    @MainActor
    func testPurchaseRefusalTextNeverPromisesAutomaticCredit() {
        for code in ["malformed_jws", "unbound_transaction", "wrong_account", "bad_chain", "unknown_product", "sandbox_rejected", ""] {
            let text = CreditsStore.refusalMessage(code: code, transactionID: 42)
            XCTAssertFalse(text.contains("automatically"), code)
        }
        XCTAssertTrue(CreditsStore.refusalMessage(code: "bad_chain", transactionID: 42).contains("42"))
    }

    // ── sessions ──

    func testSessionClaimsAndRenewalPoint() {
        let issued = Date(timeIntervalSince1970: 1_800_000_000)
        let token = session(issued: issued, expires: issued.addingTimeInterval(30 * 86_400))
        let claims = SessionToken.claims(token)
        XCTAssertEqual(claims?.uid, "alice")
        XCTAssertEqual(claims?.expiresAt, issued.addingTimeInterval(30 * 86_400))
        XCTAssertFalse(SessionToken.needsRenewal(claims!, now: issued.addingTimeInterval(14 * 86_400)))
        XCTAssertTrue(SessionToken.needsRenewal(claims!, now: issued.addingTimeInterval(16 * 86_400)))
        XCTAssertNil(SessionToken.claims("0123456789abcdef0123456789abcdef0123456789abcdef"), "a device token is not a session")
        XCTAssertNil(SessionToken.claims("a.b.c"))
        XCTAssertTrue(cloud.usesAccountSession)
        XCTAssertFalse(lan.usesAccountSession)
    }

    // ── screens ──

    func testCloudOnboardingNeverOffersMacRecovery() {
        for outcome in [VerifyOutcome.unauthorized, .unreachable, .serverError(500)] {
            XCTAssertFalse(outcome.cloudRecovery.contains(.rescan))
            XCTAssertFalse(outcome.cloudRecovery.contains(.manual))
            XCTAssertTrue(outcome.cloudRecovery.contains(.signInAgain))
        }
        XCTAssertTrue(VerifyOutcome.ok.cloudRecovery.isEmpty)
    }

    @MainActor
    func testUnverifiedNoteUsesTheServersAmount() {
        var quota = LisaClient.QuotaStatus(available: true)
        quota.windowMicroUSD = 100_000
        XCTAssertTrue(AccountCard.unverifiedNote(quota).contains("$0.10"))
        XCTAssertFalse(AccountCard.unverifiedNote(nil).contains("$"))
    }

    @MainActor
    func testPTYRefusalsNameTheCause() {
        XCTAssertTrue(AgentSends.ptyRefusal(status: 503, failure: ServerFailure(status: 503, code: "pty_disabled")).contains("turned off"))
        XCTAssertEqual(AgentSends.ptyRefusal(status: 503, failure: ServerFailure(status: 503, code: "cli_missing", message: "codex isn't installed.")),
                       "codex isn't installed.")
        XCTAssertTrue(AgentSends.ptyRefusal(status: 503, failure: ServerFailure(status: 503, code: "spawn_failed", message: "posix_spawnp failed"))
                        .contains("posix_spawnp failed"))
        XCTAssertTrue(AgentSends.ptyRefusal(status: 503, failure: nil).contains("LISA_PTY_AGENTS=1"))
    }
}
