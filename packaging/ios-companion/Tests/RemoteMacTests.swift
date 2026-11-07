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
    /// A scripted Mac (or relay) for one channel: a welcome, then one reply per sent frame.
    private final class ScriptedConnection: RemoteConnection {
        var welcome: [String: Any]
        var sent: [[String: Any]] = []
        var closed = false
        private let reply: ([String: Any]) throws -> [String: Any]
        init(welcome: [String: Any], reply: @escaping ([String: Any]) throws -> [String: Any] = { _ in
            throw URLError(.networkConnectionLost)
        }) {
            self.welcome = welcome
            self.reply = reply
        }
        func send(_ object: [String: Any]) async throws { sent.append(object) }
        func receive() async throws -> [String: Any] {
            guard let last = sent.last else { throw URLError(.networkConnectionLost) }
            return try reply(last)
        }
        func ping() async throws { }
        func close() { closed = true }
    }
    private struct PairingKeys {
        let mac = Curve25519.KeyAgreement.PrivateKey()
        let phone = Curve25519.KeyAgreement.PrivateKey()
        var host: Data { mac.publicKey.rawRepresentation }
        var client: Data { phone.publicKey.rawRepresentation }
        var target: RemoteMacTarget {
            RemoteMacTarget(id: RemoteLinkCipher.keyID(host), name: "Mac", publicKey: host.base64EncodedString(),
                            cloudOrigin: "https://cloud.example", accountUID: "alice")
        }
        /// What a v2 Mac answers to a reveal: verify it against the hello's commitment.
        func paired(_ sent: [String: Any], hello: [String: Any], macNonce: Data) throws -> [String: Any] {
            guard sent["type"] as? String == "pair", let raw = sent["nonce"] as? String,
                  let nonce = Data(base64Encoded: raw),
                  RemoteLinkCipher.pairingCommitment(host: host, client: client, nonce: nonce).base64EncodedString()
                    == hello["commit"] as? String else { throw RemoteLinkError.invalidPeer }
            return ["type": "paired", "code": RemoteLinkCipher.pairingCode(host: host, client: client,
                                                                          clientNonce: nonce, hostNonce: macNonce)]
        }
    }
    private func v2Welcome(authorized: Bool, nonce: Data?) -> [String: Any] {
        var welcome: [String: Any] = ["type": "welcome", "v": 2, "authorized": authorized, "pending": true,
                                      "challenge": "fresh", "lanURLs": [String]()]
        if let nonce { welcome["nonce"] = nonce.base64EncodedString() }
        return welcome
    }
    /// Same vectors as src/remote/protocol.test.ts (computed by node:crypto).
    func testPairingV2MatchesTheNodeVectors() throws {
        let host = Data(base64Encoded: "KrJrgJEp9nhDoI/3HXlFlO1Mm1ai02/ctyxk+Ybl9RE=")!
        let client = Data(base64Encoded: "2ktl0gKyLFDz+RxC+xSJZJan3hmcEZGlJpN5aHyx+VQ=")!
        let phoneNonce = Data(repeating: 1, count: 32), macNonce = Data(repeating: 2, count: 32)
        XCTAssertEqual(RemoteLinkCipher.code(host: host, client: client), "4743 E65C 73A8")
        XCTAssertEqual(RemoteLinkCipher.pairingCommitment(host: host, client: client, nonce: phoneNonce).base64EncodedString(),
                       "DSe7C3jhbYZodmP6aO0RbluFgaefJv9IVQQ1g/fN/j8=")
        XCTAssertEqual(RemoteLinkCipher.pairingCode(host: host, client: client, clientNonce: phoneNonce, hostNonce: macNonce),
                       "1657 5A0B 6CB6")
    }
    func testV2PairingCommitsBeforeTheRevealAndThenOnlyPollsForApproval() async throws {
        let keys = PairingKeys()
        let macNonce = Data(repeating: 9, count: 32)
        var hellos: [[String: Any]] = []
        var approved = false
        let transport = RemoteMacTransport(target: keys.target, pairing: true, credentialProvider: { "account-secret" },
                                           deviceKey: keys.phone) { url, _, _, hello in
            XCTAssertEqual(url.scheme, "wss")
            hellos.append(hello)
            return ScriptedConnection(welcome: self.v2Welcome(authorized: approved, nonce: macNonce)) { sent in
                try keys.paired(sent, hello: hello, macNonce: macNonce)
            }
        }
        let first = try await transport.pairingStatus()
        XCTAssertEqual(first.secure, true)
        XCTAssertEqual(first.open, true)
        XCTAssertEqual(first.authorized, false)
        XCTAssertNotEqual(first.code, RemoteLinkCipher.code(host: keys.host, client: keys.client))
        XCTAssertEqual(hellos[0]["v"] as? Int, 2)
        XCTAssertEqual(hellos[0]["pair"] as? Bool, true)
        XCTAssertNotNil(hellos[0]["commit"] as? String)
        approved = true
        let second = try await transport.pairingStatus()
        XCTAssertEqual(second, RemotePairingStatus(authorized: true, code: first.code, secure: true, open: true))
        XCTAssertEqual(hellos[1]["pair"] as? Bool, false, "polling for approval opens no new request")
        XCTAssertNil(hellos[1]["commit"])
        await transport.invalidate()
    }
    func testAV1MacStillPairsButIsFlaggedAsWeaker() async throws {
        let keys = PairingKeys()
        var hellos: [[String: Any]] = []
        let transport = RemoteMacTransport(target: keys.target, pairing: true, credentialProvider: { "account-secret" },
                                           deviceKey: keys.phone) { _, _, _, hello in
            hellos.append(hello)
            // Mac 0.30.0 ignores `v` and `commit` and answers as it always has.
            return ScriptedConnection(welcome: ["type": "welcome", "authorized": false, "challenge": "fresh",
                                                "code": RemoteLinkCipher.code(host: keys.host, client: keys.client)])
        }
        let status = try await transport.pairingStatus()
        XCTAssertEqual(status, RemotePairingStatus(authorized: false,
            code: RemoteLinkCipher.code(host: keys.host, client: keys.client), secure: false, open: true))
        XCTAssertEqual(hellos[0]["v"] as? Int, 2, "a v2 Mac would have answered with a nonce")
        XCTAssertNotNil(hellos[0]["commit"] as? String)
        await transport.invalidate()
    }
    func testANewMacNonceIsNeverCombinedWithAnAlreadyRevealedPhoneNonce() async throws {
        let keys = PairingKeys()
        var macNonces = [Data(repeating: 1, count: 32), Data(repeating: 2, count: 32), Data(repeating: 2, count: 32)]
        var hellos: [[String: Any]] = []
        var connections: [ScriptedConnection] = []
        let transport = RemoteMacTransport(target: keys.target, pairing: true, credentialProvider: { "account-secret" },
                                           deviceKey: keys.phone) { _, _, _, hello in
            hellos.append(hello)
            let macNonce = macNonces.removeFirst()
            let lost = connections.isEmpty
            let connection = ScriptedConnection(welcome: self.v2Welcome(authorized: false, nonce: macNonce)) { sent in
                if lost { throw URLError(.networkConnectionLost) } // the reveal went out; its reply did not arrive
                return try keys.paired(sent, hello: hello, macNonce: macNonce)
            }
            connections.append(connection)
            return connection
        }
        do { _ = try await transport.pairingStatus(); XCTFail("the reply was lost") } catch { }
        XCTAssertEqual(connections[0].sent.count, 1, "the phone nonce was revealed against the first Mac nonce")
        // The same commitment now meets a different Mac nonce (a relay re-rolling, or a restarted Mac).
        do {
            _ = try await transport.pairingStatus()
            XCTFail("a second Mac nonce must restart pairing")
        } catch RemoteLinkError.pairingRestarted { }
        XCTAssertTrue(connections[1].sent.isEmpty, "the revealed nonce is never sent against another Mac nonce")
        let fresh = try await transport.pairingStatus()
        XCTAssertNotEqual(hellos[2]["commit"] as? String, hellos[0]["commit"] as? String)
        XCTAssertEqual(fresh.secure, true)
        XCTAssertFalse(fresh.code.isEmpty)
        await transport.invalidate()
    }
    func testAMacReportingADifferentCodeIsRejectedAndAMissingNonceMeansNoOpenRequest() async throws {
        let keys = PairingKeys()
        var nonce: Data? = Data(repeating: 3, count: 32)
        let transport = RemoteMacTransport(target: keys.target, pairing: true, credentialProvider: { "account-secret" },
                                           deviceKey: keys.phone) { _, _, _, _ in
            ScriptedConnection(welcome: self.v2Welcome(authorized: false, nonce: nonce)) { _ in
                ["type": "paired", "code": "0000 0000 0000"]
            }
        }
        do {
            _ = try await transport.pairingStatus()
            XCTFail("a code the phone did not derive must not be shown")
        } catch RemoteLinkError.invalidPeer { }
        nonce = nil // dismissed on the Mac, or too many requests
        let closed = try await transport.pairingStatus()
        XCTAssertEqual(closed, RemotePairingStatus(authorized: false, code: "", secure: true, open: false))
        await transport.invalidate()
    }
    func testPairingNeverUsesCachedLANHints() async throws {
        let keys = PairingKeys()
        let cacheKey = "lisa.link.\(keys.target.id).lanURLs"
        UserDefaults.standard.set(["ws://192.168.1.2:5758/link"], forKey: cacheKey)
        defer { UserDefaults.standard.removeObject(forKey: cacheKey) }
        var schemes: [String?] = []
        let transport = RemoteMacTransport(target: keys.target, pairing: true, credentialProvider: { "account-secret" },
                                           deviceKey: keys.phone) { url, _, _, hello in
            schemes.append(url.scheme)
            return ScriptedConnection(welcome: self.v2Welcome(authorized: true, nonce: Data(repeating: 4, count: 32))) { sent in
                try keys.paired(sent, hello: hello, macNonce: Data(repeating: 4, count: 32))
            }
        }
        _ = try await transport.pairingStatus()
        XCTAssertEqual(schemes, ["wss"])
        await transport.invalidate()
    }
    func testFailedLANFallsBackBeforeSendingAndNetworkChangeRetriesLAN() async throws {
        let target = testTarget()
        let cacheKey = "lisa.link.\(target.id).lanURLs"
        UserDefaults.standard.set(["ws://192.168.1.2:5758/link"], forKey: cacheKey)
        defer { UserDefaults.standard.removeObject(forKey: cacheKey) }
        var calls: [(URL, String?)] = []
        var lanUp = false
        let transport = RemoteMacTransport(target: target, credentialProvider: { "account-secret" }) { url, token, _, _ in
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
        let transport = RemoteMacTransport(target: target, credentialProvider: { "account-secret" }) { _, _, _, _ in
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
        let transport = RemoteMacTransport(target: testTarget(), credentialProvider: { throw RemoteLinkError.signIn }) { _, _, _, _ in
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
