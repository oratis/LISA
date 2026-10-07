import XCTest
@testable import LisaPocket

private final class AccountHTTPStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class AccountLifecycleTests: XCTestCase {
    private var session: URLSession!
    private let config = ServerConfig(host: "cloud.example.com", port: 443, token: "test-session", scheme: "https")

    override func setUp() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountHTTPStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        AccountHTTPStub.handler = nil
    }

    func testAppleAuthorizationCodeIsSentOnlyToTheChosenCloudEndpoint() async throws {
        AccountHTTPStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://cloud.example.com/api/auth/apple")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            var body = request.httpBody ?? Data()
            if body.isEmpty, let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&bytes, maxLength: bytes.count)
                    if count <= 0 { break }
                    body.append(contentsOf: bytes.prefix(count))
                }
            }
            let payload = try JSONSerialization.jsonObject(with: body) as? [String: String]
            XCTAssertEqual(payload?["identityToken"], "test-identity")
            XCTAssertEqual(payload?["nonce"], "test-nonce")
            XCTAssertEqual(payload?["authorizationCode"], "one-time-test-code")
            return (200, Data(#"{"token":"new-session"}"#.utf8))
        }
        let token = try await LisaClient.exchangeAppleToken(base: config,
            identityToken: "test-identity", rawNonce: "test-nonce",
            authorizationCode: "one-time-test-code", session: session)
        XCTAssertEqual(token, "new-session")
    }

    func testDeletionCarriesAccountCredentialAndPreservesLegacyAppleFollowUp() async throws {
        AccountHTTPStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/account")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-session")
            return (200, Data(#"{"ok":true,"requiresManualAppleRevocation":true}"#.utf8))
        }
        let result = try await LisaClient(config: config, session: session).deleteAccount()
        XCTAssertEqual(result.requiresManualAppleRevocation, true)
    }

    func testRefusedDeletionNeverBecomesSuccessfulLocalSignOut() async throws {
        for status in [200, 503] {
            AccountHTTPStub.handler = { _ in (status, Data(#"{"ok":false,"error":"account_deletion_incomplete"}"#.utf8)) }
            do {
                _ = try await LisaClient(config: config, session: session).deleteAccount()
                XCTFail("A refused deletion must throw")
            } catch { /* caller keeps the account signed in for retry */ }
        }
    }
    @MainActor
    func testCreditBalanceRefreshReadsLisaLedgerWithoutAppleRestore() async {
        var requests = 0
        AccountHTTPStub.handler = { request in
            requests += 1
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/billing/quota")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-session")
            return (200, Data(#"{"available":true,"paidMicroUSD":12500000}"#.utf8))
        }
        let store = CreditsStore()
        await store.refreshBalance(client: LisaClient(config: config, session: session), isCurrent: { true })
        XCTAssertEqual(requests, 1)
        XCTAssertTrue(store.message?.contains("$12.50") == true)
        XCTAssertFalse(store.busy)
    }

    @MainActor
    func testCreditBalanceRefreshDoesNotInventSuccessOrLeakAcrossConnections() async {
        let store = CreditsStore()
        let client = LisaClient(config: config, session: session)
        for response in [(503, #"{"error":"unavailable"}"#),
                         (200, #"{"available":false}"#),
                         (200, #"{"available":true}"#)] {
            AccountHTTPStub.handler = { _ in (response.0, Data(response.1.utf8)) }
            await store.refreshBalance(client: client, isCurrent: { true })
            XCTAssertNotNil(store.message)
            XCTAssertFalse(store.message?.contains("Account balance:") == true)
            XCTAssertFalse(store.busy)
        }
        AccountHTTPStub.handler = { _ in (200, Data(#"{"available":true,"paidMicroUSD":12500000}"#.utf8)) }
        await store.refreshBalance(client: client, isCurrent: { false })
        XCTAssertNil(store.message)
        XCTAssertFalse(store.busy)
    }

}
