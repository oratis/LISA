import XCTest

final class RoomNavigationTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-lisa.mode", "mac", "-lisa.appearance", "calm"]
    }

    private func launchConnected() throws {
        let port = try XCTUnwrap(ProcessInfo.processInfo.environment["ROOM_E2E_PORT"],
                                 "Run scripts/test-ios-room.ts to start the isolated Lisa backend.")
        app.launchEnvironment["LISA_DEV_PAIR"] = "127.0.0.1|"+port+"|simulator-room-test|http"
        app.launch()
    }

    private func tile(_ id: String) -> XCUIElement { app.buttons["room.tile."+id] }
    private func open(_ id: String) {
        let button = tile(id)
        if !button.isHittable { app.swipeUp() }
        XCTAssertTrue(button.waitForExistence(timeout: 6), id)
        button.tap()
    }
    private func reveal(_ element: XCUIElement) {
        let tabBar = app.tabBars.firstMatch
        let contentBottom = tabBar.exists ? tabBar.frame.minY : app.frame.maxY - 20
        for _ in 0..<4 {
            if element.isHittable && element.frame.midY < contentBottom { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }

    private func returnToRoom() {
        let bottomTab = app.tabBars.buttons["Room"]
        if bottomTab.exists { bottomTab.tap(); return }
        // iPadOS places tabs in the floating bar at the top of the window.
        let topTab = app.buttons.matching(identifier: "Room").allElementsBoundByIndex
            .first { $0.isHittable && $0.frame.minY < 120 }
        XCTAssertNotNil(topTab)
        topTab?.tap()
    }

    private func back() {
        let bar = app.navigationBars.firstMatch
        let backButton = app.navigationBars.buttons["BackButton"].firstMatch
        if backButton.waitForExistence(timeout: 5) { backButton.tap() }
        else { bar.buttons.element(boundBy: 0).tap() }
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testNineDestinationsUseRealDataAndReturnToRoom() throws {
        try launchConnected()
        XCTAssertTrue(tile("room").waitForExistence(timeout: 8))
        let ids = ["chat","dashboard","control","reve","room","sense","memory","knowledge","settings"]
        for id in ids { XCTAssertTrue(tile(id).exists, id) }
        capture("Room-home")
        open("chat")
        XCTAssertTrue(app.buttons["Load earlier messages"].waitForExistence(timeout: 5))
        capture("Pocket-Chat")
        returnToRoom()
        open("dashboard")
        XCTAssertTrue(app.navigationBars["Dashboard"].waitForExistence(timeout: 5))
        capture("Pocket-Dashboard")
        back()
        open("control")
        XCTAssertTrue(app.navigationBars["Agents"].waitForExistence(timeout: 5))
        capture("Pocket-Agents")
        returnToRoom()
        open("reve")
        let reflected = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "5757")).firstMatch
        XCTAssertTrue(reflected.waitForExistence(timeout: 10))
        capture("Room-Reve")
        back()
        open("room")
        XCTAssertTrue(app.navigationBars["Inside the room"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["Studio"].tap()
        XCTAssertTrue(app.segmentedControls.buttons["Studio"].isSelected)
        app.segmentedControls.buttons["Sunroom"].tap()
        back()
        open("sense")
        XCTAssertTrue(app.navigationBars["Sense"].waitForExistence(timeout: 5))
        capture("Pocket-Sense")
        back()
        open("memory")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "5757")).firstMatch.waitForExistence(timeout: 8))
        capture("Pocket-Memory")
        back()
        open("knowledge")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Room field notes")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let search = app.searchFields.firstMatch
        if !search.isHittable { app.swipeDown() }
        search.tap(); search.typeText("copper")
        let other = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Garden inventory")).firstMatch
        XCTAssertTrue(other.waitForNonExistence(timeout: 8))
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()
        XCTAssertTrue(app.staticTexts["The copper bookmark is in the sunroom."].waitForExistence(timeout: 8))
        capture("Room-Knowledge-entry")
        back()
        let closeSearch = app.buttons["Close"].firstMatch
        if closeSearch.exists && closeSearch.isHittable { closeSearch.tap() }
        let cancel = app.buttons["Cancel"].firstMatch
        if cancel.exists && cancel.isHittable { cancel.tap() }
        // iPad's compact search field can retain its query when returning from
        // a result. Clear it to restore the navigation bar's back control.
        let clearSearch = app.buttons["Clear text"].firstMatch
        if clearSearch.exists && clearSearch.isHittable { clearSearch.tap() }
        back()
        open("settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        capture("Pocket-Settings")
        back()
        XCTAssertTrue(tile("room").waitForExistence(timeout: 5))
    }

    func testChatSuggestionCreatesEditableDraft() {
        // A configured but unreachable endpoint gives this test an empty transcript.
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN", "-lisa.appearance", "nebula"]
        app.launchEnvironment["LISA_DEV_PAIR"] = "127.0.0.1|1|offline-chat-test|http"
        app.launchEnvironment["LISA_DEV_TAB"] = "1"
        app.launch()
        let suggestion = app.buttons["写一份初稿"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 8))
        capture("Pocket-Chat-starters-dark")
        suggestion.tap()
        let field = app.descendants(matching: .any).matching(identifier: "chat.composer").firstMatch
        XCTAssertTrue((field.value as? String)?.contains("帮我起草一条消息") == true)
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        XCTAssertFalse(suggestion.exists)
    }

    func testChineseRoomAndOfflineRecoveryEntry() throws {
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN",
                               "-lisa.mode", "mac", "-lisa.appearance", "calm"]
        try launchConnected()
        XCTAssertTrue(tile("knowledge").waitForExistence(timeout: 8))
        XCTAssertEqual(tile("knowledge").label, "知识库")
        XCTAssertTrue(app.staticTexts["Lisa 在房间里"].waitForExistence(timeout: 8))
        capture("Room-Chinese")
        reveal(app.buttons["room.session.bbbbbbbb-0000-0000-0000-000000000001"])
        XCTAssertTrue(app.buttons["room.understanding"].label.contains("Lisa 对你的理解"))
        capture("Room-Chinese-briefing")
        app.terminate()
        app.launchArguments += ["-lisa.room.interior", "studio"]
        app.launchEnvironment["LISA_DEV_PAIR"] = "127.0.0.1|1|offline-room-test|http"
        app.launch()
        XCTAssertTrue(app.staticTexts["暂时无法连接"].waitForExistence(timeout: 12))
        reveal(app.staticTexts["room.todos.unavailable"])
        XCTAssertFalse(app.staticTexts["room.todos.empty"].exists)
        XCTAssertFalse(app.buttons["room.understanding"].label.contains("简洁"))
        app.swipeDown()
        open("settings")
        XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 6))
    }

    func testApprovalShowsFullPayloadAndResolvesOnce() throws {
        let port = try XCTUnwrap(ProcessInfo.processInfo.environment["ROOM_E2E_PORT"])
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:" + port + "/chat"))
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "message": "Update Lisa's example file."
        ])
        // Keep the real chat turn open while the phone inspects its pending tool call.
        let turn = URLSession.shared.dataTask(with: request)
        turn.resume()
        defer { turn.cancel() }
        try launchConnected()
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Lisa requests approval")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        reveal(row)
        row.tap()
        XCTAssertTrue(app.staticTexts["before"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["after"].exists)
        XCTAssertTrue(app.staticTexts["example.ts"].exists)
        capture("Room-Approval-detail")
        app.buttons["Allow once"].tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 8))
    }

    func testUnderstandingAndToDoOpenTheRightSources() throws {
        try launchConnected()
        let memory = app.buttons["room.understanding"]
        let session = app.buttons["room.session.bbbbbbbb-0000-0000-0000-000000000001"]
        reveal(session)
        XCTAssertTrue(memory.label.contains("讨论项目时"))
        if app.frame.width < 760 {
            XCTAssertLessThan(tile("knowledge").frame.maxY, memory.frame.midY)
        } else {
            XCTAssertLessThan(tile("knowledge").frame.maxX, memory.frame.minX)
        }
        XCTAssertLessThan(memory.frame.maxY, session.frame.midY)
        memory.tap()
        XCTAssertTrue(app.navigationBars["Memory"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "喜欢简洁")).firstMatch.waitForExistence(timeout: 6))
        back()
        reveal(session)
        session.tap()
        XCTAssertTrue(app.navigationBars["Atlas"].waitForExistence(timeout: 8))

        app.terminate()
        // Use the same isolated service to exercise account-mode routing.
        app.launchArguments = ["-AppleLanguages", "(en)", "-lisa.mode", "cloud"]
        try launchConnected()
        let handoff = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "room.request.")).firstMatch
        reveal(handoff)
        XCTAssertFalse(session.exists)
        handoff.tap()
        XCTAssertTrue(app.staticTexts["Verify release notes"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Allow once"].exists)
        app.buttons["Dismiss request"].tap()
        XCTAssertTrue(app.staticTexts["room.todos.empty"].waitForExistence(timeout: 8))
    }

    func testRoomObjectsAndDeepLink() throws {
        try launchConnected()
        open("room")
        app.buttons["room.object.memory"].tap()
        XCTAssertTrue(app.navigationBars["Memory"].waitForExistence(timeout: 5))
        back()
        app.buttons["room.object.control"].tap()
        XCTAssertTrue(app.navigationBars["Agents"].waitForExistence(timeout: 5))
        returnToRoom()
        app.buttons["room.object.chat"].tap()
        XCTAssertTrue(app.buttons["Load earlier messages"].waitForExistence(timeout: 5))
        app.open(URL(string: "lisapocket://roster")!)
        XCTAssertTrue(app.navigationBars["Agents"].waitForExistence(timeout: 5))
    }

    func testIPadLandscapeKeepsDestinationsReachable() throws {
        try launchConnected()
        guard app.frame.width >= 760 else { throw XCTSkip("iPad landscape acceptance") }
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        XCTAssertTrue(tile("knowledge").waitForExistence(timeout: 8))
        XCTAssertGreaterThan(app.frame.width, app.frame.height)
        open("knowledge")
        XCTAssertTrue(app.navigationBars["Knowledge"].waitForExistence(timeout: 5))
        back()
        XCTAssertTrue(tile("room").waitForExistence(timeout: 5))
        for destination in ["chat", "dashboard", "control", "reve", "room", "sense", "memory", "knowledge", "settings"] {
            XCTAssertTrue(tile(destination).isHittable, destination)
        }
        capture("Room-iPad-landscape")
    }

    func testCloudRoutesToMacSetupAndKeepsSenseLocal() throws {
        app.launchArguments = ["-AppleLanguages", "(en)", "-lisa.mode", "cloud"]
        try launchConnected()
        open("sense")
        XCTAssertTrue(app.buttons["Connection settings"].waitForExistence(timeout: 5))
        app.buttons["Connection settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        back()
        open("control")
        XCTAssertTrue(app.buttons["Set up my Mac"].waitForExistence(timeout: 5))
    }
}
