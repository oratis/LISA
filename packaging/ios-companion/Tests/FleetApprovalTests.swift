import XCTest
@testable import LisaPocket

final class FleetApprovalTests: XCTestCase {
    private func makeRun(id: String = "task", host: String = "mac", approvalID: String = "request", granted: Bool = true,
                     expires: Double = Date().addingTimeInterval(60).timeIntervalSince1970 * 1000) -> FleetTask {
        FleetTask(id: id, hostId: host, workspaceName: "Project", state: "approval", createdAt: 1,
                  updatedAt: 2, lastSeq: 1, result: "", truncated: false,
                  approval: FleetTask.Approval(tool: "Edit", target: "notes.txt", expiresAt: expires,
                                               id: approvalID, digest: "digest-\(approvalID)", preview: "{\"new_string\":\"new\"}"),
                  capabilities: FleetActions(observe: true, append: false, cancel: false, approve: granted, resume: false, handoff: false))
    }
    @MainActor private final class Client: FleetReading, FleetDecisionSending {
        var task: FleetTask
        var sent: [FleetDecision] = []
        var error: Error?
        var status = "accepted"
        var beforeReply: (() -> Void)?
        init(_ task: FleetTask) { self.task = task }
        func fleetTasks() async throws -> [FleetTask] { [task] }
        func fleetEvents(_ id: String, after: Int) async throws -> FleetPage {
            FleetPage(run: task, events: [], firstSeq: 1, lastSeq: 1, gap: false, reset: false, more: false)
        }
        func fleetDecide(_ id: String, decision: FleetDecision) async throws -> FleetDecisionReceipt {
            sent.append(decision); beforeReply?()
            if let error { throw error }
            return FleetDecisionReceipt(operationId: decision.operationId, status: status)
        }
    }
    func testOnlyAnExplicitGrantAndCompleteUnexpiredRequestEnableApproval() throws {
        XCTAssertFalse(makeRun(granted: false).canApprove)
        XCTAssertFalse(makeRun(expires: 1).canApprove)
        XCTAssertTrue(makeRun().canApprove)
        let legacy = #"{"id":"task","hostId":"mac","workspaceName":"Project","state":"approval","createdAt":1,"updatedAt":2,"lastSeq":1,"result":"","truncated":false,"approval":{"tool":"Edit","target":"notes.txt","expiresAt":9000000000000},"capabilities":{"observe":true,"append":false,"cancel":false,"approve":true,"resume":false,"handoff":false}}"#
        XCTAssertFalse(try JSONDecoder().decode(FleetTask.self, from: Data(legacy.utf8)).canApprove)
    }
    @MainActor func testLostReplyRetriesIdenticalDecisionAndDoesNotAllowChangingTheAnswer() async {
        let task = makeRun(), client = Client(makeRun()), model = FleetPocketModel()
        client.task = task
        model.selection = task.id; await model.refresh(client)
        client.error = URLError(.networkConnectionLost)
        let first = await model.decide(client, run: task, allow: true)
        XCTAssertFalse(first); XCTAssertEqual(client.sent.count, 1)
        XCTAssertFalse(model.canDecide(task, allow: false))
        let opposite = await model.decide(client, run: task, allow: false)
        XCTAssertFalse(opposite); XCTAssertEqual(client.sent.count, 1)
        client.error = nil
        let retry = await model.decide(client, run: task, allow: true)
        XCTAssertTrue(retry); XCTAssertEqual(client.sent.count, 2)
        XCTAssertEqual(client.sent[0], client.sent[1])
        XCTAssertFalse(model.canDecide(task))
    }
    @MainActor func testUnknownOutcomeOrServerRejectionCannotBeResent() async {
        for error in [nil, LisaError.http(403), LisaError.http(409)] as [Error?] {
            let task = makeRun(), model = FleetPocketModel(), client = Client(makeRun())
            client.task = task; client.status = "unknown"; client.error = error
            model.selection = task.id; await model.refresh(client)
            _ = await model.decide(client, run: task, allow: false)
            XCTAssertFalse(model.canDecide(task))
            _ = await model.decide(client, run: task, allow: false)
            XCTAssertEqual(client.sent.count, 1)
            XCTAssertNotNil(model.decisionMessage)
        }
    }
    @MainActor func testChangedRequestOrDifferentMacCannotUseAnOpenPreview() async {
        let task = makeRun(), client = Client(makeRun()), model = FleetPocketModel()
        client.task = task; model.selection = task.id; await model.refresh(client)
        client.task = makeRun(approvalID: "replacement"); await model.refresh(client)
        XCTAssertFalse(model.canDecide(task))
        _ = await model.decide(client, run: task, allow: true)
        let current = client.task
        client.task = makeRun(host: "another-mac", approvalID: "replacement"); await model.refresh(client)
        XCTAssertFalse(model.canDecide(current)); XCTAssertTrue(client.sent.isEmpty)
    }
    @MainActor func testReplyAfterLeavingTaskDoesNotChangeTheNewTaskMessage() async {
        let task = makeRun(), client = Client(makeRun()), model = FleetPocketModel()
        client.task = task; model.selection = task.id; await model.refresh(client)
        client.beforeReply = { model.selection = "another-task" }
        let result = await model.decide(client, run: task, allow: true)
        XCTAssertFalse(result); XCTAssertNil(model.decisionMessage)
        XCTAssertEqual(model.selection, "another-task"); XCTAssertNil(model.timeline.run)
    }
}
