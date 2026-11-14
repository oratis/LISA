import XCTest
@testable import Lisa

@MainActor
final class CloudAccountFlowTests: XCTestCase {
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Account flow did not reach the expected state")
    }

    func testLateExpiredSessionCannotReplaceCodeScreen() async {
        var verification: CheckedContinuation<(Int, [String: Any]), Error>?
        let connection = CloudConnectionModel(); connection.preview = true
        let services = CloudAccountServices(read: { key in key == "LISA_MANAGED_SESSION" ? "old-session" : nil }, save: { _ in }, request: { url, _, _ in
            if url.path == "/api/auth/me" { return try await withCheckedThrowingContinuation { verification = $0 } }
            return (200, ["sent": true])
        }, restart: { _ in XCTFail("Opening or signing in must not restart Lisa") })
        let model = CloudAccountModel(connection: connection, services: services)
        model.needsSignIn = true; model.start(); model.email = "alex@example.com"
        await waitFor { verification != nil }
        model.sendCode()
        await waitFor { model.step == .code }
        verification?.resume(returning: (403, [:]))
        await Task.yield()
        XCTAssertEqual(model.step, .code)
        XCTAssertNil(model.notice)
        model.stop()
    }

    func testARefusedMacSessionAsksToSignInAgain() {
        let refused = CloudConnectionState(["enabled": true, "online": false, "error": "sign_in_required"])
        XCTAssertTrue(refused.needsSignIn)
        XCTAssertTrue(CloudConnectionState(["enabled": true, "error": "relay_unreachable", "sessionExpired": true]).needsSignIn)
        XCTAssertFalse(CloudConnectionState(["enabled": true, "error": "relay_unreachable"]).needsSignIn)
        XCTAssertFalse(CloudConnectionState(["enabled": true, "online": true, "sessionExpired": true]).needsSignIn)
        let connection = CloudConnectionModel(); connection.preview = true
        connection.loaded = true; connection.state = refused
        XCTAssertEqual(connection.title, "Sign in again")
        XCTAssertTrue(connection.detail.contains("same Wi-Fi"), "LAN devices still work; say so")
    }

    func testSignInAgainShowsTheFormEvenWhileAVerificationIsInFlight() async {
        var verification: CheckedContinuation<(Int, [String: Any]), Error>?
        let connection = CloudConnectionModel(); connection.preview = true
        let saved = ["LISA_MANAGED_SESSION": "saved-session", "LISA_MANAGED_EMAIL": "alex@example.com"]
        let services = CloudAccountServices(read: { saved[$0] }, save: { _ in }, request: { url, _, _ in
            if url.path == "/api/auth/me" { return try await withCheckedThrowingContinuation { verification = $0 } }
            return (200, [:])
        }, restart: { _ in XCTFail("Signing in again must not restart Lisa") })
        let model = CloudAccountModel(connection: connection, services: services)
        model.start()
        await waitFor { verification != nil }
        XCTAssertTrue(model.showsAccount)
        model.signInAgain()
        XCTAssertFalse(model.showsAccount)
        XCTAssertEqual(model.step, .email)
        XCTAssertEqual(model.email, "alex@example.com")
        // The relay refused the session even if /api/auth/me still answers: keep the form.
        verification?.resume(returning: (200, ["signedIn": true, "email": "alex@example.com"]))
        await Task.yield()
        XCTAssertFalse(model.showsAccount, "a late verification must not hide the sign-in form")
        model.stop()
    }

    func testCodeIsBoundToTheAddressAndServerThatRequestedIt() async {
        var stored: [String: String] = [:]
        var verificationURL: URL?
        var verificationEmail: String?
        var accountVerifications = 0
        var restartCount = 0
        let connection = CloudConnectionModel(request: { _, _ in ["enabled": true, "online": false] })
        let services = CloudAccountServices(read: { stored[$0] }, save: { stored.merge($0) { _, new in new } }, request: { url, _, body in
            if url.path.hasSuffix("/request") { return (200, ["sent": true]) }
            if url.path == "/api/auth/me" { accountVerifications += 1; return (200, ["signedIn": true, "email": "alex@example.com"]) }
            verificationURL = url; verificationEmail = body?["email"] as? String
            return (200, ["token": "test-session"])
        }, restart: { done in restartCount += 1; done(true) })
        let model = CloudAccountModel(connection: connection, services: services)
        model.email = "alex@example.com"; model.sendCode()
        await waitFor { model.step == .code && !model.busy }
        model.email = "someone-else@example.com"; model.server = "https://other.example.com"; model.code = "123456"
        model.continueSignIn()
        await waitFor { model.showsAccount && !model.busy }
        XCTAssertEqual(verificationURL?.host, "cloud.meetlisa.ai")
        XCTAssertEqual(verificationEmail, "alex@example.com")
        XCTAssertEqual(stored["LISA_MANAGED_EMAIL"], "alex@example.com")
        XCTAssertEqual(stored["LISA_MANAGED_BASE"], "https://cloud.meetlisa.ai")
        XCTAssertEqual(restartCount, 0)
        XCTAssertFalse(model.applicationMessage.contains("already available"))
        model.stop(); model.start()
        await waitFor { accountVerifications == 1 }
        XCTAssertEqual(model.step, .email)
        model.stop()
    }

    func testReopeningTheWindowPreservesAnExpiredAccountsCodeStep() async {
        var verifications = 0
        let connection = CloudConnectionModel(); connection.preview = true
        let services = CloudAccountServices(read: { key in key == "LISA_MANAGED_SESSION" ? "old-session" : nil }, save: { _ in }, request: { url, _, _ in
            if url.path == "/api/auth/me" { verifications += 1; return (403, [:]) }
            return (200, ["sent": true])
        }, restart: { _ in XCTFail("Reopening must not restart Lisa") })
        let model = CloudAccountModel(connection: connection, services: services)
        model.start()
        await waitFor { model.needsSignIn }
        model.email = "alex@example.com"; model.sendCode()
        await waitFor { model.step == .code && !model.busy }
        model.code = "123456"; model.stop(); model.start()
        await Task.yield()
        XCTAssertEqual(model.step, .code)
        XCTAssertEqual(model.code, "123456")
        XCTAssertEqual(verifications, 1)
        model.stop()
    }

    func testFailedPhoneDisconnectionKeepsTheAccountVisibleAndSaved() async {
        var saved = false
        let connection = CloudConnectionModel(request: { _, _ in throw NSError(domain: "test", code: 1) })
        let model = CloudAccountModel(connection: connection, services: CloudAccountServices(
            read: { _ in nil }, save: { _ in saved = true }, request: { _, _, _ in (200, [:]) },
            restart: { _ in XCTFail("A failed sign-out must not restart Lisa") }))
        model.signedIn = true
        model.signOut()
        await waitFor { !model.busy }
        XCTAssertTrue(model.showsAccount)
        XCTAssertFalse(saved)
        XCTAssertEqual(model.notice?.kind, .error)
    }

    func testSignOutClosesRemoteAccessBeforeSavingAndApplying() async {
        var events: [String] = []
        let connection = CloudConnectionModel(request: { path, _ in events.append(path); return [:] })
        let model = CloudAccountModel(connection: connection, services: CloudAccountServices(
            read: { _ in nil }, save: { values in events.append(values["LISA_MANAGED_SESSION"] == "" ? "clear-session" : "apply-marker") },
            request: { _, _, _ in (200, [:]) }, restart: { done in events.append("restart"); done(true) }))
        model.signedIn = true; model.signOut()
        await waitFor { events.contains("restart") && !model.applying }
        XCTAssertFalse(model.signedIn)
        XCTAssertLessThan(events.firstIndex(of: "disconnect")!, events.firstIndex(of: "clear-session")!)
        XCTAssertLessThan(events.firstIndex(of: "clear-session")!, events.firstIndex(of: "restart")!)
        XCTAssertGreaterThan(events.firstIndex(of: "status")!, events.firstIndex(of: "restart")!,
                             "A refresh before applying would let another window block sign-out completion")
    }

    func testFailedAccountApplicationOffersARetryAfterSignOut() async {
        var stored: [String: String] = [:]
        let connection = CloudConnectionModel(request: { _, _ in [:] })
        let model = CloudAccountModel(connection: connection, services: CloudAccountServices(
            read: { stored[$0] }, save: { stored.merge($0) { _, new in new } },
            request: { _, _, _ in (200, [:]) }, restart: { $0(false) }))
        model.signedIn = true; model.signOut()
        await waitFor { model.applyFailed }
        XCTAssertFalse(model.signedIn)
        XCTAssertEqual(stored["LISA_MANAGED_SESSION"], "")
        XCTAssertEqual(stored["LISA_ACCOUNT_PENDING_APPLY"], "1")
        XCTAssertTrue(model.needsApply)
        XCTAssertFalse(model.applying)
    }

    func testAnotherWindowCannotReconnectDuringSignOut() async {
        var disconnect: CheckedContinuation<[String: Any], Error>?
        var reconnects = 0
        let connection = CloudConnectionModel(request: { path, _ in
            if path == "disconnect" { return try await withCheckedThrowingContinuation { disconnect = $0 } }
            if path == "connect" { reconnects += 1 }
            return [:]
        })
        let operation = Task { try await connection.disconnectAccount {} }
        await waitFor { disconnect != nil }
        await connection.connect(base: "https://cloud.meetlisa.ai", token: "test-session")
        XCTAssertEqual(reconnects, 0)
        disconnect?.resume(returning: [:])
        _ = try? await operation.value
        XCTAssertFalse(connection.busy)
    }

    func testReopeningDuringApplyKeepsFailureAndRetryVisible() async {
        var stored = ["LISA_ACCOUNT_PENDING_APPLY": "1"]
        var finishRestart: ((Bool) -> Void)?
        let connection = CloudConnectionModel(); connection.preview = true
        let model = CloudAccountModel(connection: connection, services: CloudAccountServices(
            read: { stored[$0] }, save: { stored.merge($0) { _, new in new } },
            request: { _, _, _ in (200, [:]) }, restart: { finishRestart = $0 }))
        model.needsApply = true; model.applyAccount()
        await waitFor { finishRestart != nil }
        model.stop(); model.start()
        XCTAssertTrue(model.needsApply)
        XCTAssertEqual(stored["LISA_ACCOUNT_PENDING_APPLY"], "1")
        finishRestart?(false)
        await waitFor { model.applyFailed }
        XCTAssertTrue(model.needsApply)
        XCTAssertFalse(model.applicationMessage.isEmpty)
        model.stop()
    }

    func testInvalidServerCannotReceiveCredentials() async {
        var requests = 0
        let connection = CloudConnectionModel(); connection.preview = true
        let model = CloudAccountModel(connection: connection, services: CloudAccountServices(
            read: { _ in nil }, save: { _ in XCTFail("No credentials should be saved") },
            request: { _, _, _ in requests += 1; return (200, [:]) }, restart: { _ in }))
        model.server = "http://untrusted.example.com"; model.email = "alex@example.com"
        model.continueSignIn()
        await Task.yield()
        XCTAssertFalse(model.canContinue)
        XCTAssertEqual(requests, 0)
    }
}
