import Foundation

// Pure, testable model for the first-run onboarding flow
// (docs/PLAN_IOS_ONBOARDING_v1.0.md). No SwiftUI / no side effects here, so the
// copy strings + step logic are unit-testable off the main actor.

/// Steps of the Mac-local wizard. The raw Int drives the progress dots; `.welcome`
/// and `.mode` sit before the dotted sequence. The LISA Cloud branch reuses
/// `.connect` directly after a paste, skipping install/start/pair/scan.
enum OnboardingStep: Int, CaseIterable {
    case welcome, mode, install, start, pair, scan, connect

    /// The dotted sub-sequence (install → connect) — welcome/mode are pre-flow.
    static let dotted: [OnboardingStep] = [.install, .start, .pair, .scan, .connect]
}

/// How the user installs LISA on their Mac (the "install" step). Commands are the
/// real ones from the repo README — keep them in sync.
enum InstallMethod: String, CaseIterable, Identifiable {
    case homebrew, npm, app
    var id: String { rawValue }

    var label: String {
        switch self {
        case .homebrew: return "Homebrew"
        case .npm:      return "npm"
        case .app:      return "Mac app"
        }
    }

    /// The one-line install command to copy, or nil for the download-a-.app path.
    var installCommand: String? {
        switch self {
        case .homebrew: return "brew install oratis/tap/lisa"
        case .npm:      return "npm install -g @oratis/lisa"
        case .app:      return nil
        }
    }

    /// Download page for the notarized Mac app (.dmg), nil for the CLI methods.
    var downloadURL: URL? {
        self == .app ? URL(string: "https://github.com/oratis/LISA/releases/latest") : nil
    }

    /// Whether this is a command-line install (vs the menu-bar .app).
    var isCLI: Bool { self != .app }

    /// What the user runs to start LISA *LAN-reachable* (the "start" step). CLI
    /// installs print a copy-able command; the menu-bar app needs nothing typed.
    /// Includes `LISA_WEB_TOKEN` because the server REFUSES a non-loopback bind
    /// without one (it would expose a full-tool agent to the whole Wi-Fi) — the
    /// `--host 0.0.0.0`-without-token fatal is the #1 gotcha. The phone still gets
    /// its own per-device token from `lisa pair`; this just arms the gate. Matches
    /// packaging/ios-companion/README.md.
    var serveCommand: String? {
        isCLI ? "LISA_WEB_TOKEN=$(openssl rand -hex 24) lisa serve --web --host 0.0.0.0" : nil
    }

    /// One-line "start" instruction shown with (or instead of) the command.
    var startHint: String {
        isCLI
            ? "In a terminal on your Mac, start LISA so this iPhone can reach it over Wi-Fi:"
            : "Open LISA from your Mac's menu bar — look for the Lisa icon."
    }
}

/// The command that prints the pairing QR on the Mac (the "pair" step).
let pairCommand = "lisa pair"

/// Outcome of probing the saved config before declaring the pairing a success.
/// Lets the connect screen show targeted help instead of a generic failure.
enum VerifyOutcome: Equatable {
    case ok            // reachable + token accepted
    case unreachable   // can't reach the host (wrong Wi-Fi, loopback bind, offline)
    case unauthorized  // reached a server but the token was rejected (expired/revoked)
    case serverError(Int)
}

/// A recovery action offered on a failed connect (drives the connect screen's
/// buttons). Kept pure so the outcome→action mapping is unit-testable.
enum RecoveryAction: Hashable {
    case retry, rescan, manual

    var label: String {
        switch self {
        case .retry:  return "Try again"
        case .rescan: return "Scan a fresh code"
        case .manual: return "Enter manually"
        }
    }
}

extension VerifyOutcome {
    /// Recovery actions for a failed connect, most-useful first. A rejected token
    /// can't be retried — re-scan a fresh code (run `lisa pair` again); an
    /// unreachable / erroring Mac is worth a retry.
    var recovery: [RecoveryAction] {
        switch self {
        case .ok:                        return []
        case .unauthorized:              return [.rescan, .manual]
        case .unreachable, .serverError: return [.retry, .manual]
        }
    }
}
