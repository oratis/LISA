import Foundation

/// A user-facing classification of a connection failure, so tabs show a friendly,
/// actionable message instead of dumping a raw `NSError` (the reported bug: a
/// full-screen "…Error Domain=NSURLErrorDomain Code=-999 cancelled…").
/// See docs/PLAN_IOS_REACHABILITY_v1.0.md.
enum ConnectionProblem: Equatable {
    /// -999 (NSURLErrorCancelled): the request was superseded (a newer load/task)
    /// or the network switched mid-flight. Transient — must NOT be shown.
    case cancelled
    /// Host didn't answer. `privateLAN` = the host is an RFC-1918 home-Wi-Fi IP,
    /// so it only works on that same Wi-Fi (the off-Wi-Fi case → suggest Tailscale/Cloud).
    case cannotReach(privateLAN: Bool)
    /// 401/403 — the device token was rejected/revoked.
    case unauthorized
    /// A non-auth HTTP error from the Mac.
    case serverError(Int)

    /// Classify an error thrown by `LisaClient` against the current config.
    static func classify(_ error: Error, config: ServerConfig) -> ConnectionProblem {
        if case LisaError.http(let code) = error {
            return (code == 401 || code == 403) ? .unauthorized : .serverError(code)
        }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled {
            return .cancelled
        }
        // Everything else network-ish (cannotConnectToHost / timedOut /
        // networkConnectionLost / notConnectedToInternet / cannotFindHost / …) is
        // "can't reach"; qualify it by whether the host is a private LAN address.
        return .cannotReach(privateLAN: config.isPrivateLAN)
    }

    /// True when switching to LISA Cloud is a sensible one-tap escape (the Mac
    /// itself is unreachable — R4). Not offered for auth/server errors.
    var offersCloud: Bool { if case .cannotReach = self { return true }; return false }

    /// SF Symbol for the state (unused for `.cancelled`, which never renders).
    var icon: String {
        switch self {
        case .unauthorized: return "lock.trianglebadge.exclamationmark"
        case .serverError: return "exclamationmark.triangle"
        default: return "wifi.exclamationmark"
        }
    }

    /// Title + message to show, or `nil` for `.cancelled` (transient — render nothing).
    var display: (title: String, message: String)? {
        switch self {
        case .cancelled:
            return nil
        case .cannotReach(let privateLAN):
            if privateLAN {
                return ("Can't reach Lisa",
                        "You're paired to a home-Wi-Fi address, which only works on that same Wi-Fi. "
                        + "If you've left it (e.g. on cellular), reach your Mac over Tailscale, or switch to LISA Cloud in Settings.")
            }
            return ("Can't reach Lisa",
                    "Make sure your Mac is awake and running `lisa serve --web --host 0.0.0.0`, "
                    + "and that this device can reach it from your current network.")
        case .unauthorized:
            return ("Pairing was rejected",
                    "This device's token was revoked or expired. Re-pair from Settings — run `lisa pair` on your Mac for a fresh code.")
        case .serverError(let code):
            return ("Your Mac returned an error",
                    "Lisa answered with HTTP \(code). Make sure it's up to date, then try again.")
        }
    }
}
