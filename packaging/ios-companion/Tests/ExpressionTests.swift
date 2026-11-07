import XCTest
@testable import LisaPocket

private final class ExpressionHTTPStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class ExpressionTests: XCTestCase {
    private var fixture: [String: Any] {
        let prefix = "/assets/visuals/soft-ink-motion-v1/sticker-hello"
        return ["version": 1, "id": "message-1", "assetId": "sticker-hello", "format": "animated",
                "alt": "Hello · 你好", "emoji": "👋", "animation": prefix + ".webp",
                "poster": prefix + "-static.webp", "native": prefix + ".gif", "durationMs": 3900]
    }
    func testOnlyVersionedLocalArtworkIsDecodedAndPlaybackIsCapped() throws {
        let value = try XCTUnwrap(ConversationExpression.decode(fixture))
        XCTAssertEqual(value.playbackSeconds, 5)
        for (key, invalid) in [("version", 2 as Any), ("format", "html"),
                               ("assetId", "../secret"), ("native", "https://external.example/a.gif"),
                               ("poster", "/private/file"), ("durationMs", 0)] {
            var bad = fixture; bad[key] = invalid
            XCTAssertNil(ConversationExpression.decode(bad), key)
        }
        var short = fixture; short["durationMs"] = 1200
        XCTAssertEqual(ConversationExpression.decode(short)?.playbackSeconds, 2.4)
    }
    func testAllFormatsRestoreAndUnknownVersionsKeepReadableHistory() throws {
        for format in ["animated", "static", "emoji"] {
            var expression = fixture; expression["format"] = format
            let data = try JSONSerialization.data(withJSONObject: ["role": "assistant", "content": "👋 [LISA: Hello]", "expression": expression])
            let history = try JSONDecoder().decode(HistoryMessage.self, from: data)
            XCTAssertEqual(history.expression?.format, format)
            XCTAssertEqual(history.content, "👋 [LISA: Hello]")
        }
        var unknown = fixture; unknown["version"] = 99
        let data = try JSONSerialization.data(withJSONObject: ["role": "assistant", "content": "Hello fallback", "expression": unknown])
        let history = try JSONDecoder().decode(HistoryMessage.self, from: data)
        XCTAssertNil(history.expression); XCTAssertEqual(history.content, "Hello fallback")
        let legacy = try JSONDecoder().decode(HistoryMessage.self, from: Data(#"{"role":"assistant","content":"Legacy hello"}"#.utf8))
        XCTAssertNil(legacy.expression); XCTAssertEqual(legacy.content, "Legacy hello")
    }
    func testSSEPreservesUnicodeAndExpressionIdentityAcrossByteBoundaries() throws {
        let data = try JSONSerialization.data(withJSONObject: ["type": "expression", "expression": fixture])
        var decoder = SSEDecoder()
        let events = ("data: " + String(decoding: data, as: UTF8.self) + "\n\n").utf8.compactMap { decoder.append($0) }
        XCTAssertEqual(events.count, 1)
        let expression = try XCTUnwrap(ConversationExpression.decode(events[0].object["expression"]))
        XCTAssertEqual(expression.emoji, "👋"); XCTAssertEqual(expression.id, "message-1")
    }
    func testExpressionToolIsHiddenFromHistoryChips() throws {
        let history = try JSONDecoder().decode(HistoryMessage.self, from: Data(#"{"role":"assistant","content":[{"type":"tool_use","name":"reply_expression"},{"type":"tool_use","name":"read"}]}"#.utf8))
        XCTAssertEqual(history.tools, ["read"])
    }
    @MainActor
    func testRecreatedHistoryCellsCannotAutoplayTheSameLiveExpressionAgain() throws {
        let model = ChatModel()
        let expression = try XCTUnwrap(ConversationExpression.decode(fixture))
        model.messages = [ChatMessage(role: .lisa, expression: expression, expressionLive: true)]
        let id = model.messages[0].id
        model.markExpressionSeen(id)
        XCTAssertFalse(model.messages[0].expressionLive)
        XCTAssertEqual(model.messages[0].expression, expression)
        model.markExpressionSeen(UUID())
        XCTAssertEqual(model.messages.count, 1)
    }
    func testPreferencesUseAuthenticatedClientAndRejectInvalidSavedValues() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ExpressionHTTPStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); ExpressionHTTPStub.handler = nil }
        let client = LisaClient(config: ServerConfig(host: "cloud.example", port: 443, token: "expression-token", scheme: "https"), session: session)
        var methods: [String] = []
        ExpressionHTTPStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/expressions/preferences")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer expression-token")
            methods.append(request.httpMethod!)
            return (200, Data(#"{"display":"emoji","frequency":"lively"}"#.utf8))
        }
        let loaded = try await client.expressionPreferences()
        XCTAssertEqual(loaded.display, .emoji)
        let saved = try await client.setExpressionPreferences(loaded)
        XCTAssertEqual(saved, loaded); XCTAssertEqual(methods, ["GET", "PUT"])
        XCTAssertEqual(ExpressionPreferences().display, .static, "Before settings arrive, stay still")
        XCTAssertThrowsError(try JSONDecoder().decode(ExpressionPreferences.self, from: Data(#"{"display":"unknown","frequency":"lively"}"#.utf8)))
    }
}
