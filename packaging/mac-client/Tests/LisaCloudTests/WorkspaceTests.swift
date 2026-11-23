import XCTest
import WebKit
@testable import Lisa

final class WorkspaceTests: XCTestCase {
    func testNewInstallKeepsOnboardingUntilAWorkspaceIsChosen() throws {
        let name = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(Workspace.restore(in: defaults), .welcome)
        defaults.set("saved frame", forKey: "NSWindow Frame " + Workspace.frameName)
        XCTAssertEqual(Workspace.restore(in: defaults), .welcome)
        defaults.set(Workspace.cloud.rawValue, forKey: Workspace.preference)
        XCTAssertEqual(Workspace.restore(in: defaults), .cloud)
    }

    func testUpgradeKeepsExistingLocalWorkspace() throws {
        let name = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("saved frame", forKey: "NSWindow Frame " + Workspace.frameName)
        XCTAssertEqual(Workspace.restore(in: defaults), .mac)
        defaults.removeObject(forKey: "NSWindow Frame " + Workspace.frameName)
        XCTAssertEqual(Workspace.restore(in: defaults), .mac)
    }

    func testInvalidSavedWorkspaceFallsBackSafely() throws {
        let name = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("bogus", forKey: Workspace.preference)
        XCTAssertEqual(Workspace.restore(in: defaults), .welcome)
        XCTAssertEqual(defaults.string(forKey: Workspace.preference), Workspace.welcome.rawValue)
    }

    @MainActor func testCloudOriginIncludesAccountAndExcludesOtherWorkspaces() throws {
        XCTAssertTrue(CloudWorkspace.isCloud(CloudWorkspace.home))
        XCTAssertTrue(CloudWorkspace.isCloud(try XCTUnwrap(URL(string: "https://cloud.meetlisa.ai:443/account"))))
        XCTAssertTrue(CloudWorkspace.isCloud(try XCTUnwrap(URL(string: "HTTPS://CLOUD.MEETLISA.AI/account"))))
        for address in ["http://localhost:5757/", "http://cloud.meetlisa.ai", "https://cloud.meetlisa.ai:444/",
                        "https://cloud.meetlisa.ai.example.org", "https://user@cloud.meetlisa.ai/",
                        "file:///etc/passwd", "javascript:alert(1)"] {
            XCTAssertFalse(CloudWorkspace.isCloud(try XCTUnwrap(URL(string: address))), address)
        }
    }

    @MainActor func testCloudNavigationPoliciesIsolateMainViewAndPopup() throws {
        let cloud = try XCTUnwrap(URL(string: "https://cloud.meetlisa.ai/chat"))
        let apple = try XCTUnwrap(URL(string: "https://appleid.apple.com/auth/authorize"))
        let google = try XCTUnwrap(URL(string: "https://accounts.google.com/o/oauth2/v2/auth"))
        let local = try XCTUnwrap(URL(string: "http://localhost:5757/"))
        let stripe = try XCTUnwrap(URL(string: "https://checkout.stripe.com/c/pay/cs_test"))
        let blank = try XCTUnwrap(URL(string: "about:blank"))

        XCTAssertTrue(CloudWorkspace.allowsMainFrameNavigation(cloud, inSignInPopup: false))
        XCTAssertFalse(CloudWorkspace.allowsMainFrameNavigation(apple, inSignInPopup: false))
        XCTAssertFalse(CloudWorkspace.allowsMainFrameNavigation(google, inSignInPopup: false))
        XCTAssertFalse(CloudWorkspace.allowsMainFrameNavigation(local, inSignInPopup: false))
        XCTAssertFalse(CloudWorkspace.allowsMainFrameNavigation(blank, inSignInPopup: false))

        XCTAssertTrue(CloudWorkspace.allowsMainFrameNavigation(cloud, inSignInPopup: true))
        XCTAssertTrue(CloudWorkspace.allowsMainFrameNavigation(apple, inSignInPopup: true))
        XCTAssertTrue(CloudWorkspace.allowsMainFrameNavigation(google, inSignInPopup: true))
        XCTAssertTrue(CloudWorkspace.allowsMainFrameNavigation(blank, inSignInPopup: true))
        for address in ["http://accounts.google.com/", "https://accounts.google.com:8443/",
                        "https://evil.accounts.google.com/", "https://user@appleid.apple.com/"] {
            XCTAssertFalse(CloudWorkspace.allowsMainFrameNavigation(try XCTUnwrap(URL(string: address)), inSignInPopup: true), address)
        }
        XCTAssertFalse(CloudWorkspace.allowsMainFrameNavigation(local, inSignInPopup: true))
        XCTAssertFalse(CloudWorkspace.allowsMainFrameNavigation(stripe, inSignInPopup: true))

        XCTAssertTrue(CloudWorkspace.allowsSubframeNavigation(cloud))
        XCTAssertTrue(CloudWorkspace.allowsSubframeNavigation(blank))
        XCTAssertFalse(CloudWorkspace.allowsSubframeNavigation(local))

        XCTAssertTrue(CloudWorkspace.shouldOpenExternally(stripe, navigationType: .other))
        XCTAssertTrue(CloudWorkspace.shouldOpenExternally(try XCTUnwrap(URL(string: "https://example.com/docs")), navigationType: .linkActivated))
        XCTAssertFalse(CloudWorkspace.shouldOpenExternally(try XCTUnwrap(URL(string: "https://example.com/docs")), navigationType: .other))
        XCTAssertFalse(CloudWorkspace.shouldOpenExternally(local, navigationType: .linkActivated))
    }
}
