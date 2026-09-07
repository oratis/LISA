import XCTest
@testable import LisaSetup

/// The wizard's decision logic is pure — no shell, no AppKit — so it's pinned here.
final class BackendSetupTests: XCTestCase {

    // ── ToolchainReport.parse: the probe's KEY=value lines, tolerant of noise ──

    func testParseFullReport() {
        let out = """
        Welcome banner from a chatty .zprofile
        NODE=/opt/homebrew/bin/node
        NODEV=v22.4.0
        NPM=/opt/homebrew/bin/npm
        LISA=/opt/homebrew/bin/lisa
        LISAV=0.24.0
        BREW=/opt/homebrew/bin/brew
        """
        let r = ToolchainReport.parse(out)
        XCTAssertEqual(r.nodePath, "/opt/homebrew/bin/node")
        XCTAssertEqual(r.nodeVersion, "v22.4.0")
        XCTAssertEqual(r.npmPath, "/opt/homebrew/bin/npm")
        XCTAssertEqual(r.lisaPath, "/opt/homebrew/bin/lisa")
        XCTAssertEqual(r.lisaVersion, "0.24.0")
        XCTAssertEqual(r.brewPath, "/opt/homebrew/bin/brew")
        XCTAssertFalse(r.hasServeOverride)
    }

    func testParseEmptyValuesBecomeNil() {
        let r = ToolchainReport.parse("NODE=\nNODEV=\nNPM=\nLISA=\nLISAV=\nBREW=\n")
        XCTAssertNil(r.nodePath)
        XCTAssertNil(r.nodeVersion)
        XCTAssertNil(r.lisaPath)
        XCTAssertNil(r.brewPath)
    }

    // ── decide: the four screens ──

    func testDecideNodeMissing() {
        XCTAssertEqual(BackendSetup.decide(ToolchainReport()), .nodeMissing(brewAvailable: false))
        XCTAssertEqual(BackendSetup.decide(ToolchainReport(brewPath: "/opt/homebrew/bin/brew")),
                       .nodeMissing(brewAvailable: true))
    }

    func testDecideNodeTooOld() {
        let r = ToolchainReport(nodePath: "/usr/local/bin/node", nodeVersion: "v18.20.4")
        XCTAssertEqual(BackendSetup.decide(r), .nodeTooOld(found: "v18.20.4", brewAvailable: false))
    }

    func testDecideNodeAtFloorIsFine() {
        // The floor is 22.19 (package.json engines.node), not 22 — see
        // meetsNodeFloor.
        let r = ToolchainReport(nodePath: "/usr/local/bin/node", nodeVersion: "v22.19.0")
        XCTAssertEqual(BackendSetup.decide(r), .cliMissing(nodeVersion: "v22.19.0"))
    }

    func testDecideCliMissing() {
        let r = ToolchainReport(nodePath: "/opt/homebrew/bin/node", nodeVersion: "v22.19.0",
                                npmPath: "/opt/homebrew/bin/npm")
        XCTAssertEqual(BackendSetup.decide(r), .cliMissing(nodeVersion: "v22.19.0"))
    }

    func testDecideReadyWhenCliPresent() {
        let r = ToolchainReport(nodePath: "/opt/homebrew/bin/node", nodeVersion: "v22.4.0",
                                lisaPath: "/opt/homebrew/bin/lisa", lisaVersion: "0.24.0")
        XCTAssertEqual(BackendSetup.decide(r), .ready(lisaVersion: "0.24.0"))
    }

    func testDecideCliWinsOverOddNode() {
        // A Homebrew-tap lisa carries its own node dependency; if `lisa` resolves,
        // that's what matters — don't send the user to install Node.
        let r = ToolchainReport(lisaPath: "/opt/homebrew/bin/lisa")
        XCTAssertEqual(BackendSetup.decide(r), .ready(lisaVersion: nil))
    }

    func testDecideServeOverrideIsReadyRegardless() {
        // serve-command.txt = "I run it from source"; nothing to detect or install.
        XCTAssertEqual(BackendSetup.decide(ToolchainReport(hasServeOverride: true)), .ready(lisaVersion: nil))
    }

    // ── nodeMajor ──

    func testNodeMajor() {
        XCTAssertEqual(BackendSetup.nodeMajor("v22.4.0"), 22)
        XCTAssertEqual(BackendSetup.nodeMajor("20.1.0"), 20)
        XCTAssertEqual(BackendSetup.nodeMajor(" v18.0.0\n"), 18)
        XCTAssertNil(BackendSetup.nodeMajor(""))
        XCTAssertNil(BackendSetup.nodeMajor("node: command not found"))
    }

    // ── install failure classification → the exact fix ──

    func testClassifyPermissions() {
        let out = "npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /usr/local/lib/node_modules/@oratis"
        XCTAssertEqual(BackendSetup.classifyInstallFailure(output: out, exitCode: 243), .permissions)
        XCTAssertEqual(BackendSetup.classifyInstallFailure(output: "Error: permission denied", exitCode: 1), .permissions)
    }

    func testClassifyNetwork() {
        XCTAssertEqual(BackendSetup.classifyInstallFailure(output: "npm ERR! code ENOTFOUND registry.npmjs.org", exitCode: 1), .network)
        XCTAssertEqual(BackendSetup.classifyInstallFailure(output: "npm ERR! network request to https://… failed", exitCode: 1), .network)
    }

    func testClassifyEngine() {
        XCTAssertEqual(BackendSetup.classifyInstallFailure(output: "npm WARN EBADENGINE Unsupported engine", exitCode: 1), .nodeTooOld)
    }

    func testClassifyUnknownCarriesExitCode() {
        XCTAssertEqual(BackendSetup.classifyInstallFailure(output: "something else", exitCode: 7), .unknown(exitCode: 7))
    }

    func testPermissionsFixIsTheNpmGlobalPrefixMove() {
        let fix = BackendSetup.permissionsFixScript
        XCTAssertTrue(fix.contains("npm config set prefix \"$HOME/.npm-global\""))
        XCTAssertTrue(fix.contains(".zprofile"), "login shells (Terminal + this app's zsh -lc) read ~/.zprofile")
        XCTAssertTrue(fix.hasSuffix(BackendSetup.installCommand))
        XCTAssertFalse(fix.contains("sudo"))
    }

    // ── scripts: one PATH story for detect / install / start ──

    func testProbeScriptCoversVersionManagersAndReportsAllKeys() {
        let s = BackendSetup.probeScript
        XCTAssertTrue(s.hasPrefix(BackendSetup.shellPrelude))
        for key in ["NODE=", "NODEV=", "NPM=", "LISA=", "LISAV=", "BREW="] {
            XCTAssertTrue(s.contains("echo \"\(key)"), "probe must print \(key)")
        }
        XCTAssertTrue(s.contains("lisa --version"))
        XCTAssertTrue(BackendSetup.shellPrelude.contains("nvm.sh"))
        XCTAssertTrue(BackendSetup.shellPrelude.contains("/opt/homebrew/bin"))
        XCTAssertTrue(BackendSetup.shellPrelude.contains(".npm-global/bin"))
    }

    func testStartScriptGatesOnTheCLIUnlessOverridden() {
        let gated = BackendSetup.startScript(command: "lisa serve --web --host 0.0.0.0",
                                             logPath: "/Users/x/.lisa/backend.log", requireCLI: true)
        XCTAssertTrue(gated.contains("command -v lisa"))
        XCTAssertTrue(gated.contains("echo \(BackendSetup.missingMarker); exit 0"))
        XCTAssertTrue(gated.contains("nohup lisa serve --web --host 0.0.0.0 >> '/Users/x/.lisa/backend.log' 2>&1 & disown"))
        XCTAssertTrue(gated.hasSuffix("echo \(BackendSetup.spawnedMarker)"))

        let override = BackendSetup.startScript(command: "node /src/dist/cli.js serve --web",
                                                logPath: "/tmp/l.log", requireCLI: false)
        XCTAssertFalse(override.contains("command -v lisa"))
        XCTAssertTrue(override.contains("nohup node /src/dist/cli.js serve --web >> '/tmp/l.log'"))
    }

    func testShellQuoteEscapesSingleQuotes() {
        XCTAssertEqual(BackendSetup.shellQuote("/Users/o'brien/.lisa/backend.log"),
                       "'/Users/o'\\''brien/.lisa/backend.log'")
    }

    func testInstallScriptRunsTheReadmeCommandOnTheSamePath() {
        XCTAssertTrue(BackendSetup.installScript.hasPrefix(BackendSetup.shellPrelude))
        XCTAssertTrue(BackendSetup.installScript.hasSuffix(BackendSetup.installCommand))
        XCTAssertEqual(BackendSetup.installCommand, "npm install -g @oratis/lisa")
    }

    func testSummariesNameTheBlocker() {
        XCTAssertTrue(SetupState.nodeMissing(brewAvailable: false).summary.contains("Node.js isn't installed"))
        XCTAssertTrue(SetupState.nodeTooOld(found: "v18.1.0", brewAvailable: true).summary.contains("v18.1.0"))
        XCTAssertTrue(SetupState.cliMissing(nodeVersion: "v22.4.0").summary.contains("isn't installed yet"))
        XCTAssertEqual(SetupState.ready(lisaVersion: "0.24.0").summary, "Lisa backend v0.24.0 is installed.")
        XCTAssertEqual(SetupState.ready(lisaVersion: nil).summary, "Lisa backend is installed.")
    }

    // ── the Node floor is major.minor, not major ────────────────────────────
    //
    // package.json moved engines.node to >=22.19.0 because undici (a
    // production dependency) calls worker_threads APIs added in 22.10. A
    // major-only check reports Node 22.5 as fine and then runs an
    // `npm install -g` that npm refuses with EBADENGINE — the wizard telling
    // you your environment is good minutes before it breaks, which is the
    // whole failure this floor exists to prevent.
    func testNodeVersionPartsParsesMajorAndMinor() {
        XCTAssertEqual(BackendSetup.nodeVersionParts("v22.19.0")?.major, 22)
        XCTAssertEqual(BackendSetup.nodeVersionParts("v22.19.0")?.minor, 19)
        XCTAssertEqual(BackendSetup.nodeVersionParts("24.3.1")?.minor, 3)
        XCTAssertEqual(BackendSetup.nodeVersionParts("22")?.minor, 0)
        XCTAssertNil(BackendSetup.nodeVersionParts("not-a-version"))
    }

    func testNodeFloorRejectsTheVersionsThatInstallAndThenBreak() {
        XCTAssertFalse(BackendSetup.meetsNodeFloor((major: 20, minor: 19)))
        XCTAssertFalse(BackendSetup.meetsNodeFloor((major: 22, minor: 0)))
        XCTAssertFalse(BackendSetup.meetsNodeFloor((major: 22, minor: 18)))
        XCTAssertTrue(BackendSetup.meetsNodeFloor((major: 22, minor: 19)))
        XCTAssertTrue(BackendSetup.meetsNodeFloor((major: 22, minor: 20)))
        XCTAssertTrue(BackendSetup.meetsNodeFloor((major: 24, minor: 0)))
    }

    func testDecideCallsNode22_18TooOld() {
        let report = ToolchainReport(
            nodePath: "/opt/homebrew/bin/node", nodeVersion: "v22.18.0",
            lisaPath: nil, lisaVersion: nil, brewPath: "/opt/homebrew/bin/brew",
            hasServeOverride: false
        )
        guard case .nodeTooOld = BackendSetup.decide(report) else {
            return XCTFail("22.18 is below the 22.19 floor and must not reach the install step")
        }
    }

}
