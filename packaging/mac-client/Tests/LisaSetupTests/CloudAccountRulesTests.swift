import XCTest
@testable import LisaSetup

final class CloudAccountRulesTests: XCTestCase {
    func testCredentialsOnlyGoToAServerOrigin() {
        XCTAssertEqual(CloudAccountRules.serverURL(" https://cloud.meetlisa.ai/ ")?.absoluteString, "https://cloud.meetlisa.ai")
        for value in ["http://example.com", "https://user:password@example.com", "https://example.com/api",
                      "https://example.com?token=x", "https://example.com#x", "file:///tmp/server", "not a URL"] {
            XCTAssertNil(CloudAccountRules.serverURL(value), value)
        }
    }
    func testLocalDevelopmentOriginRemainsSupported() {
        for value in ["http://localhost:5757", "http://127.0.0.1:5757", "http://[::1]:5757"] {
            XCTAssertNotNil(CloudAccountRules.serverURL(value), value)
        }
    }
    func testPastedCodesAcceptSpacesButNotUnicodeDigits() {
        XCTAssertEqual(CloudAccountRules.codeDigits("12 34-56\n"), "123456")
        XCTAssertEqual(CloudAccountRules.codeDigits("１２３４５６"), "")
        XCTAssertEqual(CloudAccountRules.codeDigits("1234567"), "123456")
    }
    func testIncompleteEmailCannotStartAuthentication() {
        for value in ["alex", "alex@", "@example.com", "a@@example.com", "alex @example.com"] {
            XCTAssertFalse(CloudAccountRules.validEmail(value), value)
        }
        XCTAssertTrue(CloudAccountRules.validEmail(" alex+phone@example.com "))
    }
    func testAccountRestartRecognizesOnlyLisaCommands() {
        XCTAssertTrue(CloudAccountRules.isLisaBackendCommand("/Applications/Lisa.app/Contents/Resources/node-runtime/bin/node /Applications/Lisa.app/Contents/Resources/backend/dist/cli.js serve --web --host 0.0.0.0"))
        XCTAssertTrue(CloudAccountRules.isLisaBackendCommand("/opt/homebrew/bin/lisa serve --web"))
        XCTAssertTrue(CloudAccountRules.isLisaBackendCommand("node /workspace/LISA/dist/cli.js serve --web"))
        for value in ["node /workspace/other/dist/cli.js serve --web", "lisa status", "node server.js", "postgres"] {
            XCTAssertFalse(CloudAccountRules.isLisaBackendCommand(value), value)
        }
    }
}
