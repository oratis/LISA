//
//  BackendSetup.swift
//  LisaSetup
//
//  Pure, AppKit-free logic behind the Mac app's backend install wizard
//  (review UX-7: "one-click download" was really a two-step install — the DMG,
//  then `npm install -g @oratis/lisa` in a terminal). Everything in this module
//  is deterministic and unit-tested (Tests/LisaSetupTests); the app target does
//  the actual I/O (BackendSetupController runs the scripts, shows the sheet).
//
//  Shape:
//    probeScript ──(zsh -lc)──▶ ToolchainReport.parse ──▶ BackendSetup.decide
//                                                              │
//        ready ◀── lisa found ────────────────────────────────┤
//        nodeMissing / nodeTooOld ◀── no usable node ─────────┤
//        cliMissing ◀── node ok, no lisa ──▶ installScript ───┘ (loop)
//

import Foundation

/// What the login-shell probe reported about this Mac.
public struct ToolchainReport: Equatable {
    public var nodePath: String?
    /// As printed by `node --version`, e.g. "v22.4.0".
    public var nodeVersion: String?
    public var npmPath: String?
    public var lisaPath: String?
    /// First line of `lisa --version`, e.g. "0.24.0".
    public var lisaVersion: String?
    public var brewPath: String?
    /// ~/.lisa/serve-command.txt is present: the user starts the backend their
    /// own way (from source, a custom host) and the CLI check doesn't apply.
    public var hasServeOverride: Bool

    public init(nodePath: String? = nil, nodeVersion: String? = nil, npmPath: String? = nil,
                lisaPath: String? = nil, lisaVersion: String? = nil, brewPath: String? = nil,
                hasServeOverride: Bool = false) {
        self.nodePath = nodePath
        self.nodeVersion = nodeVersion
        self.npmPath = npmPath
        self.lisaPath = lisaPath
        self.lisaVersion = lisaVersion
        self.brewPath = brewPath
        self.hasServeOverride = hasServeOverride
    }

    /// Parse the `KEY=value` lines printed by `BackendSetup.probeScript`. Empty
    /// values become nil; unknown lines (shell noise from a chatty ~/.zprofile)
    /// are ignored, so a decorated login shell can't break detection.
    public static func parse(_ output: String, hasServeOverride: Bool = false) -> ToolchainReport {
        var r = ToolchainReport(hasServeOverride: hasServeOverride)
        for rawLine in output.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq])
            let value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            let v: String? = value.isEmpty ? nil : value
            switch key {
            case "NODE":  r.nodePath = v
            case "NODEV": r.nodeVersion = v
            case "NPM":   r.npmPath = v
            case "LISA":  r.lisaPath = v
            case "LISAV": r.lisaVersion = v
            case "BREW":  r.brewPath = v
            default: break
            }
        }
        return r
    }
}

/// Where the wizard lands after a probe. Exactly one of these is true at a time;
/// the app maps each to a screen (checklist + the one action that unblocks it).
public enum SetupState: Equatable {
    /// The `lisa` CLI resolves on the login shell (or a serve override is in
    /// place) — nothing to install, just start it.
    case ready(lisaVersion: String?)
    /// No `node` on the login shell's PATH: offer Homebrew + nodejs.org, Re-check.
    case nodeMissing(brewAvailable: Bool)
    /// `node` exists but is older than `BackendSetup.minimumNodeMajor`.
    case nodeTooOld(found: String, brewAvailable: Bool)
    /// Node is fine and `@oratis/lisa` isn't installed globally: one-click install.
    case cliMissing(nodeVersion: String)

    /// One-line status for the wizard's header.
    public var summary: String {
        switch self {
        case .ready(let v):
            return "Lisa backend \(v.map { "v\($0) " } ?? "")is installed."
        case .nodeMissing:
            return "Node.js isn't installed on this Mac — the backend runs on it."
        case .nodeTooOld(let found, _):
            return "Node.js \(found) is too old — the backend needs \(BackendSetup.minimumNodeMajor) or newer."
        case .cliMissing(let node):
            return "Node.js \(node) found — the Lisa backend isn't installed yet."
        }
    }
}

/// Why `npm install -g @oratis/lisa` failed, from its output. Drives the exact
/// fix the wizard shows (a permissions failure gets a copy-able, one-click fix
/// rather than "see the log").
public enum InstallFailure: Equatable {
    /// EACCES / EPERM on npm's global prefix (a root-owned /usr/local/lib).
    case permissions
    /// Couldn't reach the registry.
    case network
    /// npm refused the package's `engines` requirement.
    case nodeTooOld
    case unknown(exitCode: Int32)

    public var title: String {
        switch self {
        case .permissions: return "npm can't write to its global folder."
        case .network: return "Couldn't reach the npm registry."
        case .nodeTooOld: return "npm refused: this Node.js is too old for the backend."
        case .unknown(let code): return "The install failed (exit \(code))."
        }
    }

    public var advice: String {
        switch self {
        case .permissions:
            return "That folder is owned by root. The standard fix moves global packages into your home folder — no sudo — then retries the install:"
        case .network:
            return "Check your connection (and any proxy or VPN), then retry."
        case .nodeTooOld:
            return "Install Node.js \(BackendSetup.minimumNodeMajor) or newer (Homebrew or nodejs.org), then Re-check."
        case .unknown:
            return "The log below has npm's own message. You can also run the command in Terminal."
        }
    }
}

public enum BackendSetup {
    /// package.json `engines.node` — keep in sync.
    public static let minimumNodeMajor = 20
    public static let npmPackage = "@oratis/lisa"
    public static let installCommand = "npm install -g @oratis/lisa"
    public static let manualServeCommand = "lisa serve --web"
    public static let brewNodeCommand = "brew install node"
    public static let nodeDownloadURL = URL(string: "https://nodejs.org/en/download")!
    public static let homebrewURL = URL(string: "https://brew.sh")!

    /// PATH prelude for every shell the app spawns. A GUI app's login shell
    /// (`zsh -lc`) runs ~/.zprofile but not ~/.zshrc, which is where nvm / fnm /
    /// Homebrew shims usually live — so a Node that "works in Terminal" can be
    /// invisible here. Cover the common homes explicitly, and source nvm / fnm
    /// when present, so detection, install and `lisa serve` all see the same
    /// tools.
    public static let shellPrelude = """
    export PATH="$HOME/.npm-global/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    if [ -z "${NVM_DIR:-}" ] && [ -d "$HOME/.nvm" ]; then export NVM_DIR="$HOME/.nvm"; fi
    if [ -s "${NVM_DIR:-/nonexistent}/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; fi
    if command -v fnm >/dev/null 2>&1; then eval "$(fnm env 2>/dev/null)"; fi
    """

    /// Reports node / npm / lisa / brew as `KEY=value` lines (ToolchainReport.parse).
    public static var probeScript: String {
        shellPrelude + "\n" + """
        echo "NODE=$(command -v node 2>/dev/null)"
        echo "NODEV=$(node --version 2>/dev/null)"
        echo "NPM=$(command -v npm 2>/dev/null)"
        echo "LISA=$(command -v lisa 2>/dev/null)"
        echo "LISAV=$(lisa --version 2>/dev/null | head -n 1)"
        echo "BREW=$(command -v brew 2>/dev/null)"
        """
    }

    /// Markers the start script prints so the app can tell "spawned" from
    /// "there is no CLI to spawn" without waiting for a 20 s poll to time out.
    public static let spawnedMarker = "LISA_SPAWNED"
    public static let missingMarker = "LISA_MISSING"

    /// The script BackendController.start() runs: spawn `command` fully detached
    /// (nohup + & + disown, output appended to `logPath`), or — when
    /// `requireCLI` and `lisa` doesn't resolve — print the missing marker and
    /// exit so the wizard can take over. A serve-command override passes
    /// `requireCLI: false`: the user owns that command line.
    public static func startScript(command: String, logPath: String, requireCLI: Bool) -> String {
        var lines = [shellPrelude]
        if requireCLI {
            lines.append("if ! command -v lisa >/dev/null 2>&1; then echo \(missingMarker); exit 0; fi")
        }
        lines.append("nohup \(command) >> \(shellQuote(logPath)) 2>&1 & disown")
        lines.append("echo \(spawnedMarker)")
        return lines.joined(separator: "\n")
    }

    /// One-click install: the same command the README gives, on the same PATH
    /// the app will later start the backend from.
    public static var installScript: String {
        shellPrelude + "\n" + installCommand
    }

    /// The standard npm fix for an EACCES global install (no sudo): point the
    /// global prefix at ~/.npm-global, put its bin on PATH for login shells
    /// (~/.zprofile — what both Terminal and this app's `zsh -lc` read), then
    /// install. Shown verbatim with a Copy button and runnable as-is.
    public static let permissionsFixScript = """
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"
    grep -qs 'npm-global/bin' "$HOME/.zprofile" || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.zprofile"
    export PATH="$HOME/.npm-global/bin:$PATH"
    npm install -g @oratis/lisa
    """

    public static var permissionsFixRunScript: String {
        shellPrelude + "\n" + permissionsFixScript
    }

    /// The wizard's decision. Order matters: an installed CLI (or an override)
    /// wins even when Node looks wrong, because `lisa` resolving on this PATH
    /// is the thing that actually has to be true.
    public static func decide(_ r: ToolchainReport) -> SetupState {
        let brew = r.brewPath != nil
        if r.hasServeOverride || r.lisaPath != nil {
            return .ready(lisaVersion: r.lisaVersion)
        }
        guard let nodeVersion = r.nodeVersion, let major = nodeMajor(nodeVersion) else {
            return .nodeMissing(brewAvailable: brew)
        }
        if major < minimumNodeMajor {
            return .nodeTooOld(found: nodeVersion, brewAvailable: brew)
        }
        return .cliMissing(nodeVersion: nodeVersion)
    }

    /// "v22.4.0" / "22.4.0" → 22. nil when there's no leading number.
    public static func nodeMajor(_ version: String) -> Int? {
        var s = Substring(version.trimmingCharacters(in: .whitespacesAndNewlines))
        if s.hasPrefix("v") || s.hasPrefix("V") { s = s.dropFirst() }
        let digits = s.prefix { $0.isNumber }
        return digits.isEmpty ? nil : Int(digits)
    }

    /// Classify a failed install from npm's combined output. Only meaningful
    /// for a non-zero exit.
    public static func classifyInstallFailure(output: String, exitCode: Int32) -> InstallFailure {
        let o = output.lowercased()
        if o.contains("eacces") || o.contains("eperm") || o.contains("permission denied") {
            return .permissions
        }
        if o.contains("ebadengine") || o.contains("unsupported engine") {
            return .nodeTooOld
        }
        for needle in ["enotfound", "etimedout", "econnreset", "econnrefused", "eai_again", "network"]
        where o.contains(needle) {
            return .network
        }
        return .unknown(exitCode: exitCode)
    }

    /// Single-quote a string for sh/zsh.
    public static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
