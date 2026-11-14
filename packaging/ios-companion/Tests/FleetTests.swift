import XCTest
@testable import LisaPocket

final class FleetTests: XCTestCase {
    func testCapabilitiesDecodeWithoutGrantingPocketControlAndLegacyHostsStillWork() throws {
        let json = #"{"id":"task","hostId":"mac","workspaceName":"Project","state":"completed","createdAt":1,"updatedAt":2,"lastSeq":3,"result":"reviewed","truncated":false,"agent":"codex","capabilities":{"observe":true,"append":false,"cancel":false,"approve":false,"resume":false,"handoff":false}}"#
        let task = try JSONDecoder().decode(FleetTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.agent, "codex")
        XCTAssertEqual(task.accessLabel, "Read only")
        XCTAssertEqual(task.capabilities?.approve, false)
        XCTAssertEqual(task.capabilities?.resume, false)
        XCTAssertTrue(run().canObserve, "older hosts omit capabilities and retain the read-only view")
    }
    @MainActor func testWithdrawnObservationClosesTheSelectedTask() async {
        let client = Client(), model = FleetPocketModel()
        client.runs = [run()]; client.pages = [page([1])]
        model.selection = "task-a"
        await model.refresh(client)
        var unavailable: FleetTask = run()
        unavailable.capabilities = FleetActions(observe: false, append: false, cancel: false, approve: false, resume: false, handoff: false)
        client.runs = [unavailable]
        await model.refresh(client)
        XCTAssertTrue(model.runs.isEmpty)
        XCTAssertNil(model.selection)
        XCTAssertTrue(model.timeline.entries.isEmpty)
    }
    @MainActor func testObservationWithdrawnBetweenListAndPageClearsCachedDetails() async {
        let client = Client(), model = FleetPocketModel()
        client.runs = [run()]; client.pages = [page([1])]
        model.selection = "task-a"
        await model.refresh(client)
        var unavailable: FleetTask = run()
        unavailable.capabilities = FleetActions(observe: false, append: false, cancel: false, approve: false, resume: false, handoff: false)
        client.pages = [FleetPage(run: unavailable, events: [], firstSeq: 1, lastSeq: 1, gap: false, reset: false, more: false)]
        await model.refresh(client)
        XCTAssertTrue(model.runs.isEmpty)
        XCTAssertNil(model.selection)
        XCTAssertTrue(model.timeline.entries.isEmpty)
    }
    private func run(host: String = "mac-a", id: String = "task-a", last: Int = 4) -> FleetTask {
        FleetTask(id: id, hostId: host, workspaceName: "Project", state: "waiting", createdAt: 1,
                  updatedAt: 10, lastSeq: last, result: "result", truncated: false, approval: nil)
    }
    private func page(_ sequences: [Int], first: Int = 1, last: Int = 4,
                      reset: Bool = false, more: Bool = false, host: String = "mac-a") -> FleetPage {
        FleetPage(run: run(host: host, last: last), events: sequences.map { FleetEntry(seq: $0, at: 10, type: "turn_completed") },
                  firstSeq: first, lastSeq: last, gap: first > 1, reset: reset, more: more)
    }
    func testReconnectDeduplicatesPagesAndDoesNotSkipToTheLatestSequence() {
        var timeline = FleetTimeline()
        timeline.merge(page([1, 2], more: true))
        XCTAssertEqual(timeline.cursor, 2)
        timeline.merge(page([2, 3, 4]))
        timeline.merge(page([]))
        XCTAssertEqual(timeline.entries.map(\.seq), [1, 2, 3, 4])
        XCTAssertEqual(timeline.cursor, 4)
    }
    func testPrunedHistoryAndResetDiscardCachedEntries() {
        var timeline = FleetTimeline()
        timeline.merge(page([1, 2, 3, 4]))
        timeline.merge(page([], first: 3))
        XCTAssertEqual(timeline.entries.map(\.seq), [3, 4])
        XCTAssertTrue(timeline.historyLimited)
        timeline.merge(page([1], last: 1, reset: true))
        XCTAssertEqual(timeline.entries.map(\.seq), [1])
        XCTAssertEqual(timeline.cursor, 1)
        XCTAssertFalse(timeline.historyLimited)
        timeline.merge(page([2], host: "mac-b"))
        XCTAssertEqual(timeline.entries.map(\.seq), [2], "same task ID on a different Mac cannot reuse history")
    }
    @MainActor private final class Client: FleetReading {
        var runs: [FleetTask] = []
        var pages: [FleetPage] = []
        var cursors: [Int] = []
        var error: Error?
        var beforePage: (() -> Void)?
        func fleetTasks() async throws -> [FleetTask] {
            if let error { throw error }
            return runs
        }
        func fleetEvents(_ id: String, after: Int) async throws -> FleetPage {
            cursors.append(after)
            beforePage?()
            return pages.removeFirst()
        }
    }
    @MainActor func testOfflineThenReconnectCatchesUpAndRevocationClosesDetail() async {
        let client = Client(), model = FleetPocketModel()
        client.runs = [run()]
        client.pages = [page([1, 2], more: true), page([3, 4])]
        model.selection = "task-a"
        await model.refresh(client)
        XCTAssertEqual(client.cursors, [0, 2])
        XCTAssertEqual(model.timeline.cursor, 4)
        client.error = URLError(.networkConnectionLost)
        await model.refresh(client)
        XCTAssertEqual(model.timeline.cursor, 4)
        XCTAssertNotNil(model.message)
        client.error = nil
        client.pages = [page([5], last: 5)]
        await model.refresh(client)
        XCTAssertEqual(client.cursors.last, 4)
        XCTAssertEqual(model.timeline.entries.map(\.seq), [1, 2, 3, 4, 5])
        XCTAssertNil(model.message)
        client.runs = []
        await model.refresh(client)
        XCTAssertNil(model.selection)
        XCTAssertTrue(model.timeline.entries.isEmpty)
    }
    @MainActor func testAuthorizationFailuresClearPrivateDataAndLatePagesCannotReopenDetail() async {
        for error in [LisaError.http(403), LisaError.http(404), RemoteLinkError.notAllowed] as [Error] {
            let client = Client(), model = FleetPocketModel()
            client.runs = [run()]
            client.pages = [page([1])]
            model.selection = "task-a"
            await model.refresh(client)
            client.error = error
            await model.refresh(client)
            XCTAssertTrue(model.runs.isEmpty)
            XCTAssertTrue(model.timeline.entries.isEmpty)
            XCTAssertNil(model.selection)
        }
        let client = Client(), model = FleetPocketModel()
        client.runs = [run()]
        client.pages = [page([1])]
        client.beforePage = { model.selection = nil }
        model.selection = "task-a"
        await model.refresh(client)
        XCTAssertNil(model.timeline.run)
        XCTAssertEqual(model.timeline.cursor, 0)
    }
}
