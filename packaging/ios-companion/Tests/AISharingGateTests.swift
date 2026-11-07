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

/// Every Agents-tab send, as the views call it.
private enum AgentSend: String, CaseIterable {
    case managedTask, claudeTask, codexTask, managedFollowUp, ptyFollowUp, adopt

    /// The one request the Mac should see once consent allows it.
    var expected: (path: String, body: [String: String]) {
        switch self {
        case .managedTask: return ("/api/agents/managed/start", ["task": "Refactor the parser"])
        case .claudeTask: return ("/api/agents/pty/start", ["agent": "claude", "task": "Refactor the parser"])
        case .codexTask: return ("/api/agents/pty/start", ["agent": "codex", "task": "Refactor the parser"])
        case .managedFollowUp: return ("/api/agents/managed/s1/send", ["text": "Refactor the parser"])
        case .ptyFollowUp: return ("/api/agents/pty/s1/send", ["text": "Refactor the parser"])
        case .adopt: return ("/api/agents/pty/start", ["agent": "claude", "resumeSessionId": "s1"])
        }
    }
}

/// The Agents tab sends user text to AI through the same consent as Chat
/// (App Review 5.1.2(i)). These drive `AgentSends`, which the Roster views call,
/// against a stubbed Mac: a send that skipped the gate would reach the stub.
final class AISharingGateTests: XCTestCase {
    private let mac = ServerConfig(host: "mac.example", port: 5757, token: "device-token")
    private let otherMac = ServerConfig(host: "other.example", port: 5757, token: "device-token")
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

    /// Start `send` the way its view does. The returned box fills in when the
    /// send finishes; it stays nil while asking or after a silent drop.
    @MainActor
    private func start(_ send: AgentSend, gate: AISharingGate, app: AppState) -> OutcomeBox {
        let box = OutcomeBox()
        let done: @MainActor (AgentSends.Outcome) -> Void = { box.value = $0 }
        let text = "Refactor the parser"
        let running = AgentSession(agent: "claude-code", sessionId: "s1", project: "lisa",
                                   state: "working", stateReason: "",
                                   controllable: send == .managedFollowUp ? "managed" : "pty")
        let idle = AgentSession(agent: "claude-code", sessionId: "s1", project: "lisa",
                                state: "idle", stateReason: "", resumable: true)
        switch send {
        case .managedTask:
            AgentSends.delegate(kind: "managed", task: text, app: app, gate: gate, client: client, done: done)
        case .claudeTask:
            AgentSends.delegate(kind: "claude", task: text, app: app, gate: gate, client: client, done: done)
        case .codexTask:
            AgentSends.delegate(kind: "codex", task: text, app: app, gate: gate, client: client, done: done)
        case .managedFollowUp, .ptyFollowUp:
            AgentSends.followUp(text, to: running, app: app, gate: gate, client: client, done: done)
        case .adopt:
            AgentSends.adopt(idle, app: app, gate: gate, client: client, done: done)
        }
        return box
    }

    /// `start`, then wait for the check (and any send it allowed) to finish.
    @MainActor
    @discardableResult
    private func run(_ send: AgentSend, gate: AISharingGate, app: AppState) async -> AgentSends.Outcome? {
        let box = start(send, gate: gate, app: app)
        await gate.work?.value
        return box.value
    }

    @MainActor
    private func waitUntil(_ condition: () -> Bool, _ what: String) async throws {
        for _ in 0..<2000 where !condition() { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    @MainActor
    func testDelegationIsRefusedWithoutMatchingConsent() async throws {
        for send in AgentSend.allCases {
            MacAgentStub.reset()
            let app = makeApp(recipients: ["Anthropic"])
            let gate = AISharingGate()
            let label = send.rawValue

            // No consent: the sheet is asked for, nothing reaches the Mac.
            let asked = await run(send, gate: gate, app: app)
            XCTAssertNil(asked, label)
            XCTAssertEqual(gate.request?.purpose, .delegation, label)
            XCTAssertEqual(gate.request?.recipients, ["Anthropic"], label)
            XCTAssertFalse(gate.busy, label)
            XCTAssertTrue(MacAgentStub.agentRequests.isEmpty, label)
            gate.request = nil  // Cancel — the view keeps its text

            // Chat permission for the same recipients doesn't cover agent sends.
            grant(app, ["Anthropic"], .chat)
            await run(send, gate: gate, app: app)
            XCTAssertEqual(gate.request?.purpose, .delegation, label)
            XCTAssertTrue(MacAgentStub.agentRequests.isEmpty, label)
            gate.request = nil

            // Delegation allowed for another recipient list (before the Mac
            // turned PTY agents on, say) doesn't cover the current one…
            grant(app, ["OpenAI"], .delegation)
            await run(send, gate: gate, app: app)
            XCTAssertEqual(gate.request?.recipients, ["Anthropic"], label)
            XCTAssertTrue(MacAgentStub.agentRequests.isEmpty, label)
            gate.request = nil

            // …nor does delegation allowed on another connection.
            grant(app, ["Anthropic"], .delegation, on: otherMac)
            await run(send, gate: gate, app: app)
            XCTAssertNotNil(gate.request, label)
            XCTAssertTrue(MacAgentStub.agentRequests.isEmpty, label)
            gate.request = nil

            // A server with no usable recipient list is refused outright.
            app.loadAIDisclosure = { _ in nil }
            await run(send, gate: gate, app: app)
            XCTAssertNil(gate.request, label)
            XCTAssertTrue(MacAgentStub.agentRequests.isEmpty, label)

            // Allow from the sheet: exactly the expected request, once.
            app.loadAIDisclosure = { _ in Disclosure(version: 1, recipients: ["Anthropic"]) }
            let box = start(send, gate: gate, app: app)
            await gate.work?.value
            let request = try XCTUnwrap(gate.request, label)
            gate.allow(request, app: app)
            await gate.work?.value
            XCTAssertEqual(box.value, .sent, label)
            XCTAssertTrue(app.aiConsent.allows(server: mac, recipients: ["Anthropic"], purpose: .delegation), label)
            let sent = MacAgentStub.agentRequests
            XCTAssertEqual(sent.map(\.path), [send.expected.path], label)
            for (key, value) in send.expected.body {
                XCTAssertEqual(sent.first?.body[key] as? String, value, "\(label).\(key)")
            }

            // With matching consent the next one goes straight through.
            let again = await run(send, gate: gate, app: app)
            XCTAssertEqual(again, .sent, label)
            XCTAssertNil(gate.request, label)
            XCTAssertEqual(MacAgentStub.agentRequests.count, 2, label)
        }
    }

    @MainActor
    func testWithdrawingConsentCancelsPendingDelegateRequest() async throws {
        let app = makeApp(recipients: ["Anthropic"])
        let gate = AISharingGate()

        // 1. Consent sheet open: withdrawing drops it. A late Allow from a sheet
        //    still on screen (SwiftUI writing the old request back) neither
        //    grants nor sends, and the stale grant is refused on its own too.
        await run(.managedTask, gate: gate, app: app)
        let pending = try XCTUnwrap(gate.request)
        app.withdrawAIConsent()
        XCTAssertNil(gate.request)
        XCTAssertFalse(gate.busy)
        gate.request = pending
        gate.allow(pending, app: app)
        await gate.work?.value
        XCTAssertFalse(app.aiConsent.isGranted)
        XCTAssertFalse(app.grantAISharing(pending), "a grant for a withdrawn generation must fail")
        XCTAssertFalse(app.aiConsent.isGranted)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)
        gate.request = nil

        // 2. Consent was given, but withdrawn while the recipient check is still
        //    in flight: no sheet, no send.
        grant(app, ["Anthropic"], .delegation)
        let held = HeldDisclosure()
        app.loadAIDisclosure = { _ in await held.wait() }
        let checked = start(.ptyFollowUp, gate: gate, app: app)
        let checking = try XCTUnwrap(gate.work)
        try await waitUntil({ held.isWaiting }, "the recipient check")
        app.withdrawAIConsent()
        XCTAssertFalse(gate.busy)
        held.release(Disclosure(version: 1, recipients: ["Anthropic"]))
        await checking.value
        XCTAssertNil(checked.value)
        XCTAssertNil(gate.request)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)

        // 3. The request is already on its way to the Mac: withdrawing cancels
        //    it, frees the gate, and tells the view the Mac may have it.
        app.loadAIDisclosure = { _ in Disclosure(version: 1, recipients: ["Anthropic"]) }
        grant(app, ["Anthropic"], .delegation)
        let cancelled = expectation(description: "delegate request cancelled")
        MacAgentStub.reset(hold: true, cancelled: cancelled)
        let sent = start(.claudeTask, gate: gate, app: app)
        let sending = try XCTUnwrap(gate.work)
        try await waitUntil({ !MacAgentStub.agentRequests.isEmpty }, "the delegate request")
        XCTAssertTrue(gate.busy)
        app.withdrawAIConsent()
        await fulfillment(of: [cancelled], timeout: 5)
        await sending.value
        XCTAssertEqual(sent.value, .withdrawn)
        XCTAssertFalse(gate.busy)
        XCTAssertNil(gate.work)
    }

    /// `AppState.activate` withdraws consent on every switch (covered above);
    /// this changes only the connection, so the server-binding guards are the
    /// only thing standing between the old check or sheet and a send.
    @MainActor
    func testSwitchingConnectionDropsPendingDelegateRequest() async throws {
        let app = makeApp(recipients: ["Anthropic"])
        let gate = AISharingGate()
        grant(app, ["Anthropic"], .delegation)

        // 1. Mid-check: the result is stale, nothing is asked or sent.
        let held = HeldDisclosure()
        app.loadAIDisclosure = { _ in await held.wait() }
        let checked = start(.managedTask, gate: gate, app: app)
        let checking = try XCTUnwrap(gate.work)
        try await waitUntil({ held.isWaiting }, "the recipient check")
        app.config = otherMac
        held.release(Disclosure(version: 1, recipients: ["Anthropic"]))
        await checking.value
        XCTAssertNil(checked.value)
        XCTAssertNil(gate.request)
        XCTAssertFalse(gate.busy)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)

        // 2. Sheet open for the first Mac, Allow tapped after switching: the
        //    grant itself is refused, so nothing is granted or sent.
        app.config = mac
        app.withdrawAIConsent()
        app.loadAIDisclosure = { _ in Disclosure(version: 1, recipients: ["Anthropic"]) }
        let asked = start(.adopt, gate: gate, app: app)
        await gate.work?.value
        let pending = try XCTUnwrap(gate.request)
        XCTAssertEqual(pending.server, mac)
        app.config = otherMac
        gate.allow(pending, app: app)
        await gate.work?.value
        XCTAssertNil(asked.value)
        XCTAssertFalse(app.aiConsent.isGranted)
        XCTAssertFalse(gate.busy)
        XCTAssertTrue(MacAgentStub.agentRequests.isEmpty)
    }
}

@MainActor
private final class OutcomeBox {
    var value: AgentSends.Outcome?
}
