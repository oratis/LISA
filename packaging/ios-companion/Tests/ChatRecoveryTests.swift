import XCTest
@testable import LisaPocket

private final class HistoryRecoveryStub: URLProtocol {
    static var beforeResponse: (() async -> Void)?
    static var body = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Task {
            await Self.beforeResponse?()
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Self.body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

final class ChatRecoveryTests: XCTestCase {
    @MainActor
    func testRecoveryKeepsNewerChatAndRequiresTheDroppedQuestion() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HistoryRecoveryStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); HistoryRecoveryStub.beforeResponse = nil }
        let client = LisaClient(config: ServerConfig(host: "history.example", port: 443, scheme: "https"), session: session)
        let model = ChatModel()
        let dropped = [ChatMessage(role: .user, text: "Current question"),
                       ChatMessage(role: .lisa, status: .error, dropped: true)]
        model.messages = dropped
        HistoryRecoveryStub.body = Data(#"{"messages":[{"role":"user","content":"Old question"},{"role":"assistant","content":"Old answer"}],"page":0,"hasMore":false}"#.utf8)
        await model.recoverDroppedTurn(client)
        XCTAssertEqual(model.messages, dropped)

        HistoryRecoveryStub.body = Data(#"{"messages":[{"role":"user","content":"Current question"},{"role":"assistant","content":"Recovered answer"}],"page":0,"hasMore":false}"#.utf8)
        let newer = [ChatMessage(role: .user, text: "New question"), ChatMessage(role: .lisa, text: "New answer")]
        HistoryRecoveryStub.beforeResponse = { await MainActor.run { model.messages = newer } }
        await model.recoverDroppedTurn(client)
        XCTAssertEqual(model.messages, newer)

        HistoryRecoveryStub.beforeResponse = nil
        model.messages = dropped
        await model.recoverDroppedTurn(client)
        XCTAssertEqual(model.messages.last?.text, "Recovered answer")
        XCTAssertFalse(model.messages.last?.dropped ?? true)
    }
}
