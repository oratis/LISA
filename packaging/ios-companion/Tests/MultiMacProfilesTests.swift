import XCTest
@testable import LisaPocket

final class MultiMacProfilesTests: XCTestCase {
    private func fixture() -> (UserDefaults, String) {
        let name = "multi-mac-\(UUID().uuidString)"
        return (UserDefaults(suiteName: name)!, name)
    }
    private func remote(_ id: String, account: String = "alice", origin: String = "https://cloud.example") -> ServerConfig {
        var config = ServerConfig(host: "\(id).lisa.invalid", port: 443, token: nil, scheme: "https")
        config.remoteMac = RemoteMacTarget(id: id, name: "Same name", publicKey: "key-\(id)",
                                           cloudOrigin: origin, accountUID: account)
        return config
    }
    private func cloud(_ uid: String) -> ServerConfig {
        let payload = try! JSONSerialization.data(withJSONObject: ["uid": uid, "iat": 1000, "exp": 9_000_000_000_000])
            .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return ServerConfig(host: "cloud.example", port: 443, token: "s1.\(payload).test", scheme: "https")
    }

    func testSavedMacsSurviveRestartAndSwitchWithSeparateCredentials() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        var tokens: [String: String] = [:]
        let make = { ConnectionProfiles(defaults: d, readToken: { tokens[$0] }, writeToken: { tokens[$0] = $1 }) }
        let profiles = make()
        let first = ServerConfig(host: "build.example", port: 5757, token: "build-secret")
        let second = ServerConfig(host: "review.example", port: 5757, token: "review-secret")
        XCTAssertTrue(profiles.save(first, for: .mac))
        let firstID = try XCTUnwrap(profiles.activeMacID)
        XCTAssertTrue(profiles.save(second, for: .mac))
        let secondID = try XCTUnwrap(profiles.activeMacID)
        let reopened = make()
        XCTAssertEqual(reopened.savedMacs.count, 2)
        XCTAssertEqual(reopened.load(.mac), second)
        XCTAssertTrue(reopened.selectMac(firstID))
        XCTAssertEqual(reopened.load(.mac), first)
        XCTAssertTrue(reopened.selectMac(secondID))
        XCTAssertEqual(reopened.load(.mac), second)
        let data = try XCTUnwrap(d.data(forKey: "lisa.macProfiles.v1"))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("secret"))
    }

    func testSingleMacUpgradeKeepsExistingPinAndToken() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        d.set(true, forKey: "lisa.profiles.migrated")
        d.set("legacy.example", forKey: "lisa.profile.mac.host")
        d.set(5757, forKey: "lisa.profile.mac.port")
        var tokens = ["mac": "existing-device-token"]
        let profiles = ConnectionProfiles(defaults: d, readToken: { tokens[$0] }, writeToken: { tokens[$0] = $1 })
        let migrated = try XCTUnwrap(profiles.savedMacs.first)
        XCTAssertEqual(migrated.host, "legacy.example")
        XCTAssertTrue(profiles.save(remote("second"), for: .mac))
        XCTAssertTrue(profiles.selectMac(migrated.id))
        XCTAssertEqual(profiles.load(.mac).token, "existing-device-token")
    }

    func testSameNamedRemoteMacsKeepTheirOwnPinsAndForgettingDoesNotSwitchOthers() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        var tokens: [String: String] = [:]
        let profiles = ConnectionProfiles(defaults: d, readToken: { tokens[$0] }, writeToken: { tokens[$0] = $1 })
        let a = remote("aaa"), b = remote("bbb")
        XCTAssertTrue(profiles.save(a, for: .mac)); let aid = try XCTUnwrap(profiles.activeMacID)
        XCTAssertTrue(profiles.save(b, for: .mac)); let bid = try XCTUnwrap(profiles.activeMacID)
        XCTAssertNotEqual(aid, bid)
        XCTAssertTrue(profiles.selectMac(aid)); XCTAssertEqual(profiles.load(.mac).remoteMac, a.remoteMac)
        XCTAssertTrue(profiles.forgetMac(bid)); XCTAssertEqual(profiles.load(.mac), a)
        XCTAssertFalse(profiles.selectMac(bid))
        XCTAssertTrue(profiles.forgetMac(aid)); XCTAssertFalse(profiles.load(.mac).isConfigured)
    }

    func testAccountSwitchAndSignOutRemoveEveryAccountMacButKeepDirectConnections() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        var tokens: [String: String] = [:]
        let profiles = ConnectionProfiles(defaults: d, readToken: { tokens[$0] }, writeToken: { tokens[$0] = $1 })
        XCTAssertTrue(profiles.save(cloud("alice"), for: .cloud))
        let direct = ServerConfig(host: "192.168.1.9", port: 5757, token: "direct-token")
        XCTAssertTrue(profiles.save(direct, for: .mac)); let directID = try XCTUnwrap(profiles.activeMacID)
        XCTAssertTrue(profiles.save(remote("one"), for: .mac))
        XCTAssertTrue(profiles.save(remote("two"), for: .mac))
        XCTAssertEqual(profiles.savedMacs.count, 3)
        XCTAssertTrue(profiles.save(cloud("bob"), for: .cloud))
        XCTAssertEqual(profiles.savedMacs.map(\.id), [directID])
        XCTAssertFalse(profiles.load(.mac).isConfigured)
        XCTAssertTrue(profiles.save(remote("one", account: "bob"), for: .mac))
        XCTAssertTrue(profiles.selectMac(directID))
        XCTAssertTrue(profiles.save(ServerConfig(host: "", port: 443, token: nil, scheme: "https"), for: .cloud))
        XCTAssertEqual(profiles.savedMacs.map(\.id), [directID])
        XCTAssertEqual(profiles.load(.mac), direct)
    }

    func testLockedProfileCredentialCannotReplaceTheActiveMacOrEraseTheSavedToken() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        var tokens: [String: String] = [:]
        var locked: String?
        let profiles = ConnectionProfiles(defaults: d, readToken: { $0 == locked ? nil : tokens[$0] },
                                           writeToken: { if $0 != locked { tokens[$0] = $1 } })
        XCTAssertTrue(profiles.save(ServerConfig(host: "one", port: 5757, token: "one-secret"), for: .mac))
        let first = try XCTUnwrap(profiles.savedMacs.first)
        let second = ServerConfig(host: "two", port: 5757, token: "two-secret")
        XCTAssertTrue(profiles.save(second, for: .mac))
        locked = first.credentialAccount
        XCTAssertFalse(profiles.selectMac(first.id))
        XCTAssertEqual(profiles.load(.mac), second)
        XCTAssertEqual(tokens[first.credentialAccount], "one-secret")
        locked = nil
        XCTAssertTrue(profiles.selectMac(first.id))
        XCTAssertEqual(profiles.load(.mac).token, "one-secret")
    }

    func testFailedActiveKeychainWritePreservesCatalogueAndCurrentConnection() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        var tokens: [String: String] = [:]
        var locked = false
        let profiles = ConnectionProfiles(defaults: d, readToken: { tokens[$0] },
            writeToken: { if !locked || $0 != "mac" { tokens[$0] = $1 } })
        let first = ServerConfig(host: "one", port: 5757, token: "first-token")
        XCTAssertTrue(profiles.save(first, for: .mac))
        let catalogue = profiles.savedMacs
        locked = true
        XCTAssertFalse(profiles.save(ServerConfig(host: "two", port: 5757, token: "second-token"), for: .mac))
        XCTAssertEqual(profiles.load(.mac), first)
        XCTAssertEqual(profiles.savedMacs, catalogue)
        XCTAssertFalse(tokens.values.contains("second-token"))
    }
    func testLockedSingleMacMigrationWaitsWithoutDeletingTheExistingCredential() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        d.set(true, forKey: "lisa.profiles.migrated")
        d.set("existing", forKey: "lisa.profile.mac.host")
        var tokens = ["mac": "keep-me"], locked = true
        let make = { ConnectionProfiles(defaults: d, readToken: { locked ? nil : tokens[$0] },
            tokenReadable: { _ in !locked }, writeToken: { tokens[$0] = $1 }) }
        XCTAssertTrue(make().savedMacs.isEmpty)
        XCTAssertEqual(tokens["mac"], "keep-me")
        locked = false
        let recovered = make()
        XCTAssertEqual(recovered.savedMacs.count, 1)
        XCTAssertTrue(try recovered.selectMac(XCTUnwrap(recovered.activeMacID)))
        XCTAssertEqual(recovered.load(.mac).token, "keep-me")
    }

    func testProfileIdentityIncludesAccountAndCloudAndCapacityDoesNotChangeSelection() throws {
        let (d, name) = fixture(); defer { d.removePersistentDomain(forName: name) }
        var tokens: [String: String] = [:]
        let profiles = ConnectionProfiles(defaults: d, readToken: { tokens[$0] }, writeToken: { tokens[$0] = $1 })
        XCTAssertTrue(profiles.save(remote("same"), for: .mac))
        XCTAssertTrue(profiles.save(remote("same", account: "bob"), for: .mac))
        XCTAssertTrue(profiles.save(remote("same", origin: "https://elsewhere.example"), for: .mac))
        XCTAssertEqual(profiles.savedMacs.count, 3)
        for i in 3..<32 { XCTAssertTrue(profiles.save(remote("mac-\(i)"), for: .mac)) }
        let before = profiles.load(.mac)
        XCTAssertFalse(profiles.save(remote("overflow"), for: .mac))
        XCTAssertEqual(profiles.load(.mac), before)
        XCTAssertEqual(profiles.savedMacs.count, 32)
        XCTAssertTrue(profiles.save(before, for: .mac), "existing connections still update at the cap")
    }

}
