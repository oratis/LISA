import XCTest
@testable import Lisa

final class RoomWindowTests: XCTestCase {
    func testAllowedNavigationOnlyPermitsLoopbackRoom() {
        XCTAssertTrue(RoomWindowConfig.isAllowedNavigation(RoomWindowConfig.roomURL))
        XCTAssertTrue(RoomWindowConfig.isAllowedNavigation(URL(string: "http://127.0.0.1:5757/room?theme=stargazer")))
        XCTAssertTrue(RoomWindowConfig.isAllowedNavigation(URL(string: "about:blank")))

        XCTAssertFalse(RoomWindowConfig.isAllowedNavigation(nil))
        XCTAssertFalse(RoomWindowConfig.isAllowedNavigation(URL(string: "https://example.com/room")))
        XCTAssertFalse(RoomWindowConfig.isAllowedNavigation(URL(string: "http://localhost:5757/api/config")))
        XCTAssertFalse(RoomWindowConfig.isAllowedNavigation(URL(string: "http://localhost:8080/room")))
        XCTAssertFalse(RoomWindowConfig.isAllowedNavigation(URL(string: "file:///etc/passwd")))
    }

    func testVisibilityMessageTargetsWindowOrigin() {
        let showJS = RoomWindowConfig.visibilityMessageJS(visible: true)
        XCTAssertTrue(showJS.contains("lisa-room-visibility"))
        XCTAssertTrue(showJS.contains("visible: true"))
        XCTAssertTrue(showJS.contains("window.location.origin"))

        let hideJS = RoomWindowConfig.visibilityMessageJS(visible: false)
        XCTAssertTrue(hideJS.contains("visible: false"))
    }

    func testDefaultSizeMeetsMinimumBounds() {
        XCTAssertGreaterThanOrEqual(RoomWindowConfig.defaultSize.width, RoomWindowConfig.minSize.width)
        XCTAssertGreaterThanOrEqual(RoomWindowConfig.defaultSize.height, RoomWindowConfig.minSize.height)
    }
}
