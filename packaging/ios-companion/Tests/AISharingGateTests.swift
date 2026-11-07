import XCTest
@testable import LisaPocket

/// Stands in for the Mac. Records each request's path and JSON body; with
/// `hold` on it never answers, so a test can watch the client cancel it.
private final class MacAgentStub: URLProtocol {
    private static let lock = NSLock()
    private static var _requests: [(path: String, body: [String: Any])] = []
    private static var _hold = false
    private static var _cancelled: XCTestExpectation?

    static var agentRequests: [(path: String, body: [String: Any])] {
        lock.lock(); defer { lock.unlock() }
        return _requests.filter { $0.path.hasPrefix("/api/agents/") }
    }
    static func reset(hold: Bool = false, cancelled: XCTestExpectation? = nil) {
        lock.lock(); defer { lock.unlock() }
        _requests = []
        _hold = hold
        _cancelled = cancelled
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = (try? JSONSerialization.jsonObject(with: Self.readBody(request))) as? [String: Any]
        Self.lock.lock()
        Self._requests.append((request.url?.path ?? "", body ?? [:]))
        let hold = Self._hold
        Self.lock.unlock()
        if hold { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        Self.lock.lock(); defer { Self.lock.unlock() }
        if Self._hold { Self._cancelled?.fulfill(); Self._cancelled = nil }
    }

    private static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }
}

private typealias Disclosure = LisaClient.AuthConfig.DataProcessing

/// A disclosure fetch the test releases by hand, to withdraw consent mid-check.
@MainActor
private final class HeldDisclosure {
    private var continuation: CheckedContinuation<Disclosure?, Never>?
    var isWaiting: Bool { continuation != nil }
    func wait() async -> Disclosure? {
        await withCheckedContinuation { continuation = $0 }
    }
    func release(_ value: Disclosure?) {
        continuation?.resume(returning: value)
        continuation = nil
    }
}

/// The Agents tab sends user text to AI through the same consent as Chat
/// (App Review 5.1.2(i)): these drive the gate the Roster uses with the real
/// delegate request (`startDelegatedTask`) against a stubbed Mac.
final class AISharingGateTests: XCTestCase {
    private let mac = ServerConfig(host: "mac.example", port: 5757, token: "device-token")
    private var session: URLSession!
    private var client: LisaClient!

    override func setUp() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MacAgentStub.self]
        session = URLSession(configuration: configuration)
        client = LisaClient(config: mac, session: session)
        MacAgentStub.reset()
    }

    override func tearDown() {
        session.invalidateAndCancel()
        MacAgentStub.reset()
    }

    @MainActor
    private func makeApp(recipients: [String]?) -> AppState {
        let app = AppState()
        app.config = mac
        app.loadAIDisclosure = { _ in recipients.map { Disclosure(version: 1, recipients: $0) } }
        return app
    }

    @MainActor
    private func grant(_ app: AppState, _ recipients: [String], _ purpose: AISharingPurpose,
                       on server: ServerConfig? = nil) {
        XCTAssertTrue(app.aiConsent.grant(server: server ?? mac, recipients: recipients, purpose: purpose,
                                          isAdult: true, generation: app.aiConsent.generation))
    }

    /// What DelegateSheet.start does, minus the view. Returns once the check
    /// (and any send it allowed) has finished.
    @MainActor
    private func delegate(_ task: String, gate: AISharingGate, app: AppState) async {
        let client = client!
        gate.submit(task, purpose: .delegation, app: app) { text in
            _ = await startDelegatedTask(kind: "managed", task: text, client: client)
        }
        await gate.work?.value
    }

    @MainActor
    private func waitUntil(_ condition: () -> Bool, _ what: String) async throws {
        for _ in 0..<2000 where !condition() { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    @MainActor
    func testDelegationIsRefusedWithoutMatchingConsent() async throws {
        let app = makeApp(recipients: ["Anthropic"])
        let gate = AISharingGate()

        // No consent: the sheet is asked for with the typed task, nothing is sent.
        await delegate("Refactor the parser", gate: gate, app: app)
        let asked = try XCTUnwrap(gate.request)
        XCTAssertEqual(asked.purpose, .delegation)
        XCTAssertEqual(asked.recipients, ["Anthropic"])
        XCTAssertEqual(asked.text, "Refactor the parser")
        XCTAssertFalse(gate.busy)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)
        gate.request = nil  // Cancel — keep task

        // Chat permission for the same recipients doesn't cover an agent task.
        grant(app, ["Anthropic"], .chat)
        await delegate("Refactor the parser", gate: gate, app: app)
        XCTAssertEqual(gate.request?.purpose, .delegation)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)
        gate.request = nil

        // Delegation allowed for a different recipient list (before the Mac
        // turned PTY agents on, say) doesn't cover the current one.
        grant(app, ["OpenAI"], .delegation)
        await delegate("Refactor the parser", gate: gate, app: app)
        XCTAssertEqual(gate.request?.recipients, ["Anthropic"])
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)
        gate.request = nil

        // …nor does delegation allowed on another connection.
        grant(app, ["Anthropic"], .delegation,
              on: ServerConfig(host: "other.example", port: 5757, token: "device-token"))
        await delegate("Refactor the parser", gate: gate, app: app)
        XCTAssertNotNil(gate.request)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)
        gate.request = nil

        // A server with no usable recipient list is refused outright.
        app.loadAIDisclosure = { _ in nil }
        await delegate("Refactor the parser", gate: gate, app: app)
        XCTAssertNil(gate.request)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)

        // Allowing from the sheet sends exactly the typed task, once.
        app.loadAIDisclosure = { _ in Disclosure(version: 1, recipients: ["Anthropic"]) }
        await delegate("Refactor the parser", gate: gate, app: app)
        let request = try XCTUnwrap(gate.request)
        gate.allow(request, app: app)
        await gate.work?.value
        XCTAssertNil(gate.request)
        XCTAssertTrue(app.aiConsent.allows(server: mac, recipients: ["Anthropic"], purpose: .delegation))
        XCTAssertEqual(MacAgentStub.agentRequests.map(\.path), ["/api/agents/managed/start"])
        XCTAssertEqual(MacAgentStub.agentRequests.first?.body["task"] as? String, "Refactor the parser")

        // With matching consent the next task goes straight through.
        await delegate("Then add tests", gate: gate, app: app)
        XCTAssertNil(gate.request)
        XCTAssertEqual(MacAgentStub.agentRequests.count, 2)
    }

    @MainActor
    func testWithdrawingConsentCancelsPendingDelegateRequest() async throws {
        let app = makeApp(recipients: ["Anthropic"])
        let gate = AISharingGate()
        let client = client!

        // 1. Consent sheet open: withdrawing drops it, and a late Allow can't
        //    grant or send anything.
        await delegate("Ship the release", gate: gate, app: app)
        let pending = try XCTUnwrap(gate.request)
        app.withdrawAIConsent()
        XCTAssertNil(gate.request)
        XCTAssertFalse(gate.busy)
        gate.allow(pending, app: app)
        await gate.work?.value
        XCTAssertFalse(app.grantAISharing(pending))
        XCTAssertFalse(app.aiConsent.isGranted)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)

        // 2. Consent was given, but withdrawn while the recipient check is still
        //    in flight: no sheet, no send.
        grant(app, ["Anthropic"], .delegation)
        let held = HeldDisclosure()
        app.loadAIDisclosure = { _ in await held.wait() }
        gate.submit("Ship the release", purpose: .delegation, app: app) { text in
            _ = await startDelegatedTask(kind: "managed", task: text, client: client)
        }
        let checking = try XCTUnwrap(gate.work)
        try await waitUntil({ held.isWaiting }, "the recipient check")
        app.withdrawAIConsent()
        XCTAssertFalse(gate.busy)
        held.release(Disclosure(version: 1, recipients: ["Anthropic"]))
        await checking.value
        XCTAssertNil(gate.request)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)

        // 3. The delegate request is already on its way to the Mac: withdrawing
        //    cancels it, and the gate is free again.
        app.loadAIDisclosure = { _ in Disclosure(version: 1, recipients: ["Anthropic"]) }
        grant(app, ["Anthropic"], .delegation)
        let cancelled = expectation(description: "delegate request cancelled")
        MacAgentStub.reset(hold: true, cancelled: cancelled)
        var finishedUncancelled = false
        gate.submit("Ship the release", purpose: .delegation, app: app) { text in
            _ = await startDelegatedTask(kind: "managed", task: text, client: client)
            finishedUncancelled = !Task.isCancelled
        }
        let sending = try XCTUnwrap(gate.work)
        try await waitUntil({ !MacAgentStub.agentRequests.isEmpty }, "the delegate request")
        XCTAssertTrue(gate.busy)
        app.withdrawAIConsent()
        await fulfillment(of: [cancelled], timeout: 5)
        await sending.value
        XCTAssertFalse(finishedUncancelled)
        XCTAssertFalse(gate.busy)
        XCTAssertNil(gate.work)
    }
}
