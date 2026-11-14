import XCTest

/// The Chat composer is a multi-line field (Return adds a line) and its keyboard
/// covers the tab bar, so the screen must always offer a way to put the keyboard
/// away. These drive focus rather than the on-screen keyboard itself: a simulator
/// with a connected hardware keyboard never shows one, but focus moves the same.
final class ChatKeyboardUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// Opens the Chat tab with onboarding skipped. Paired launches use the DEBUG
    /// `LISA_DEV_PAIR` hook with an address nothing listens on; unpaired ones pin
    /// the stored cloud profile empty so leftovers from other tests can't pair it.
    private func launchChat(paired: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-lisa.onboarded", "YES", "-lisa.profiles.migrated", "YES"]
        app.launchEnvironment["LISA_DEV_TAB"] = "1"
        if paired {
            app.launchEnvironment["LISA_DEV_PAIR"] = "127.0.0.1|9|ui-test-token|http"
        } else {
            app.launchArguments += ["-lisa.mode", "cloud", "-lisa.profile.cloud.host", ""]
        }
        app.launch()
        return app
    }

    private func composer(_ app: XCUIApplication) -> XCUIElement {
        // A vertical-axis TextField is a text view to XCUITest, so match any type.
        app.descendants(matching: .any).matching(identifier: "chat.composer").firstMatch
    }

    private func focusComposer(_ app: XCUIApplication) -> XCUIElement {
        let field = composer(app)
        XCTAssertTrue(field.waitForExistence(timeout: 15), "the Chat composer never appeared")
        field.tap()
        let hide = app.buttons["chat.hideKeyboard"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5), "focusing the composer showed no Hide keyboard button")
        return hide
    }

    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    func testHideKeyboardButtonEndsEditing() {
        let app = launchChat(paired: true)
        let hide = focusComposer(app)
        hide.tap()
        XCTAssertTrue(waitUntilGone(hide), "Hide keyboard left the composer focused")
    }

    func testTappingTheConversationEndsEditing() {
        let app = launchChat(paired: true)
        let hide = focusComposer(app)
        let transcript = app.scrollViews["chat.transcript"]
        XCTAssertTrue(transcript.exists)
        // iOS 27 includes the area underneath the translucent navigation bar.
        // Tap the middle of the visible conversation, not the title bar.
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitUntilGone(hide), "tapping the conversation left the composer focused")
    }

    func testUnconfiguredChatPointsToSetupInsteadOfTyping() {
        let app = launchChat(paired: false)
        XCTAssertTrue(app.buttons["chat.getStarted"].waitForExistence(timeout: 15),
                      "an unconnected Chat tab must offer Get started")
        let field = composer(app)
        XCTAssertTrue(field.exists)
        XCTAssertFalse(field.isEnabled, "an unconnected composer can't send, so it must not take the keyboard")
    }
}
