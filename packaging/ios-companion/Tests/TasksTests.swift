import XCTest
@testable import LisaPocket

final class TasksTests: XCTestCase {
    func testClientCapabilitiesDecodeTruthfullyIncludingUnknownStatuses() throws {
        let json = """
        {
          "edition": "cloud",
          "surface": "cloud",
          "profile": "cloud-chat",
          "location": "cloud",
          "canApprove": true,
          "tasks": { "status": "disabled", "reason": "Cloud tasks disabled.", "supportedKinds": [] },
          "approvals": { "status": "available" },
          "connectors": { "status": "unsupported", "reason": "Mac only." },
          "localTools": { "status": "unsupported" },
          "cloudWorkspace": { "status": "available" },
          "artifacts": { "status": "future_state" }
        }
        """
        let caps = try JSONDecoder().decode(ClientCapabilities.self, from: Data(json.utf8))
        XCTAssertEqual(caps.edition, "cloud")
        XCTAssertFalse(caps.tasks.isAvailable)
        XCTAssertEqual(caps.tasks.reason, "Cloud tasks disabled.")
        XCTAssertTrue(caps.approvals.isAvailable)
        XCTAssertFalse(caps.artifacts.isAvailable)
    }

    func testConservativeFallbackNeverFakesCloudTasks() {
        let cloud = ClientCapabilities.conservativeFallback(isCloud: true)
        XCTAssertFalse(cloud.tasks.isAvailable)
        XCTAssertTrue(cloud.tasks.supportedKinds.isEmpty)
        XCTAssertFalse(cloud.canApprove)

        let mac = ClientCapabilities.conservativeFallback(isCloud: false)
        XCTAssertTrue(mac.tasks.isAvailable)
        XCTAssertEqual(mac.location, "mac")
    }

    func testTaskGoalMilestonesAndSafeArtifactDecoding() throws {
        let taskJson = """
        {
          "id": "tsk_1",
          "kind": "goal",
          "title": "Ship Q4 report",
          "instruction": "Compile metrics and draft summary.",
          "host": "home",
          "state": "scheduled",
          "enabled": true,
          "schedule": { "expr": "weekdays:09:00", "tz": "America/Los_Angeles" },
          "goalMilestones": [
            { "id": "m1", "title": "Gather data", "done": true, "evidence": "metrics.csv verified" },
            { "id": "m2", "title": "Draft brief", "done": false }
          ]
        }
        """
        let task = try JSONDecoder().decode(LisaTask.self, from: Data(taskJson.utf8))
        XCTAssertEqual(task.scheduleDisplay, "weekdays:09:00 (America/Los_Angeles)")
        XCTAssertEqual(task.goalMilestones?.count, 2)
        XCTAssertEqual(task.goalMilestones?.first?.evidence, "metrics.csv verified")

        let runJson = """
        {
          "id": "run_1",
          "taskId": "tsk_1",
          "startedAt": 1700000000000,
          "state": "succeeded",
          "summary": "Brief ready.",
          "artifacts": [
            {
              "id": "brief",
              "kind": "file",
              "title": "Q4 Brief",
              "filename": "brief.md",
              "previewUrl": "/api/tasks/tsk_1/runs/run_1/artifacts/brief",
              "downloadUrl": "/api/tasks/tsk_1/runs/run_1/artifacts/brief?download=1"
            }
          ]
        }
        """
        let run = try JSONDecoder().decode(LisaTaskRun.self, from: Data(runJson.utf8))
        XCTAssertEqual(run.artifacts?.first?.displayTitle, "Q4 Brief")
        XCTAssertNil(run.artifacts?.first?.value)
    }
}
