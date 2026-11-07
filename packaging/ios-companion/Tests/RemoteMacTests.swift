import XCTest
import CryptoKit
@testable import LisaPocket

final class RemoteMacTests: XCTestCase {
    private final class Connection: RemoteConnection {
        var welcome: [String: Any] = ["authorized": true, "challenge": "fresh", "lanURLs": ["ws://192.168.1.2:5758/link"]]
        var sent: [[String: Any]] = []
        var failAfterSend = false
        var closed = false
        var responses: [[String: Any]] = [
            ["type": "headers", "status": 200],
            ["type": "chunk", "body": Data("connected".utf8).base64EncodedString()],
            ["type": "end"],
        ]
        func send(_ object: [String: Any]) async throws { sent.append(object) }
        func receive() async throws -> [String: Any] {
            if failAfterSend { throw URLError(.networkConnectionLost) }
            return responses.removeFirst()
        }
        func ping() async throws { }
        func close() { closed = true }
    }
    private func testTarget() -> RemoteMacTarget {
        RemoteMacTarget(id: UUID().uuidString, name: "Mac", publicKey: "fixture", cloudOrigin: "https://cloud.example", accountUID: "alice")
    }
    func testFailedLANFallsBackBeforeSendingAndNetworkChangeRetriesLAN() async throws {
        let target = testTarget()
        let cacheKey = "lisa.link.\(target.id).lanURLs"
        UserDefaults.standard.set(["ws://192.168.1.2:5758/link"], forKey: cacheKey)
        defer { UserDefaults.standard.removeObject(forKey: cacheKey) }
        var calls: [(URL, String?)] = []
        var lanUp = false
        let transport = RemoteMacTransport(target: target, credentialProvider: { "account-secret" }) { url, token, _ in
            calls.append((url, token))
            if url.scheme == "ws" && !lanUp { throw URLError(.timedOut) }
            return Connection()
        }
        let (data, response) = try await transport.data(path: "/api/edition", method: "GET", body: nil)
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "connected")
        XCTAssertEqual(calls.map { $0.0.scheme }, ["ws", "wss"])
        XCTAssertNil(calls[0].1, "Account credentials must never reach a LAN endpoint")
        XCTAssertEqual(calls[1].1, "account-secret")
        lanUp = true
        await transport.networkChanged()
        _ = try await transport.data(path: "/api/edition", method: "GET", body: nil)
        XCTAssertEqual(calls.map { $0.0.scheme }, ["ws", "wss", "ws"])
        await transport.invalidate()
    }
    func testMutationIsNeverResentAfterUncertainDelivery() async throws {
        let target = testTarget()
        let cacheKey = "lisa.link.\(target.id).lanURLs"
        UserDefaults.standard.set(["ws://192.168.1.2:5758/link"], forKey: cacheKey)
        defer { UserDefaults.standard.removeObject(forKey: cacheKey) }
        let connection = Connection(); connection.failAfterSend = true
        var attempts = 0
        let transport = RemoteMacTransport(target: target, credentialProvider: { "account-secret" }) { _, _, _ in
            attempts += 1; return connection
        }
        do {
            _ = try await transport.data(path: "/chat", method: "POST", body: Data("{}".utf8))
            XCTFail("Interrupted delivery must surface to the caller")
        } catch { XCTAssertTrue(error is RemoteLinkError) }
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(connection.sent.count, 1)
        XCTAssertTrue(connection.closed)
        await transport.invalidate()
    }
    func testSignedOutAccountDoesNotEvenProbeTheLAN() async {
        var attempts = 0
        let transport = RemoteMacTransport(target: testTarget(), credentialProvider: { throw RemoteLinkError.signIn }) { _, _, _ in
            attempts += 1; return Connection()
        }
        do { _ = try await transport.data(path: "/api/edition", method: "GET", body: nil); XCTFail() }
        catch { XCTAssertTrue(error is RemoteLinkError) }
        XCTAssertEqual(attempts, 0)
        await transport.invalidate()
    }
    /// Produced by node:crypto + src/remote/protocol.ts, not by the Swift implementation.
    func testNodeHostCiphertextDecryptsWithCryptoKitAndRejectsReplay() throws {
        let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation:
            Data(base64Encoded: "mBFQJLYjo5d2ZksWoxyI77Ay6tJask8TYLlh29lBk3M=")!)
        let host = Data(base64Encoded: "KrJrgJEp9nhDoI/3HXlFlO1Mm1ai02/ctyxk+Ybl9RE=")!
        let cipher = try RemoteLinkCipher(privateKey: privateKey, host: host, salt: Data(repeating: 7, count: 32))
        XCTAssertEqual(RemoteLinkCipher.keyID(host), "ca9d5694ad5884462cdc9a0f6b69c578")
        XCTAssertEqual(RemoteLinkCipher.code(host: host, client: privateKey.publicKey.rawRepresentation), "4743 E65C 73A8")
        let frame = Data(#"{"seq":0,"box":"NaqBjpvOnYHvsl9rsj5Gow8wtTvpoyqWMOC1M410TqjPh7gpkWdO9tWn2nA1pkn1jKeGCPSPAzOUSw8ou8GUqywKx0b259pzhMEncm87G7+AtAZ8/n0M2cqxwOQLmdVblig="}"#.utf8)
        let opened = try cipher.open(frame)
        XCTAssertEqual(opened["challenge"] as? String, "cross-language-test")
        XCTAssertEqual(opened["authorized"] as? Bool, true)
        XCTAssertThrowsError(try cipher.open(frame))
        let wrong = try RemoteLinkCipher(privateKey: .init(), host: host, salt: Data(repeating: 7, count: 32))
        XCTAssertThrowsError(try wrong.open(frame))
    }
    func testLANHintsCannotRedirectCredentialsOrProbePublicAndLoopbackServices() {
        for value in ["ws://127.0.0.1:80/link", "ws://169.254.169.254:80/link", "ws://8.8.8.8:80/link",
                      "ws://192.168.1.2:80/admin", "ws://user:password@192.168.1.2:80/link",
                      "https://192.168.1.2:80/link", "ws://192.168.1.2:80/link?token=secret"] {
            XCTAssertNil(RemoteMacTransport.validLANURL(value), value)
        }
        XCTAssertNotNil(RemoteMacTransport.validLANURL("ws://192.168.1.2:5758/link"))
        XCTAssertNotNil(RemoteMacTransport.validLANURL("ws://10.1.2.3:5758/link"))
    }
    func testRemoteMacPinSurvivesProfileReloadAndLegacyPairingClearsIt() {
        let suite = "RemoteMacTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var tokens: [String: String] = [:]
        let profiles = ConnectionProfiles(defaults: defaults,
            readToken: { tokens[$0] }, writeToken: { tokens[$0] = $1 })
        let target = RemoteMacTarget(id: "mac-id", name: "My Mac", publicKey: "pinned-key",
                                     cloudOrigin: "https://cloud.example", accountUID: "alice")
        var mac = ServerConfig(host: "mac-id.lisa.invalid", port: 443, token: nil, scheme: "https")
        mac.remoteMac = target
        XCTAssertTrue(profiles.save(mac, for: .mac))
        XCTAssertEqual(profiles.load(.mac).remoteMac, target)
        XCTAssertNil(profiles.load(.cloud).remoteMac)
        XCTAssertTrue(profiles.save(ServerConfig(host: "192.168.1.2", port: 5757, token: "legacy"), for: .mac))
        XCTAssertNil(profiles.load(.mac).remoteMac)
    }
}
