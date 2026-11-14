import Foundation

/// A user-facing classification of a failure, so screens show what actually went
/// wrong and the one step that fixes it, instead of a raw `NSError` or a blanket
/// "can't reach Lisa". See docs/PLAN_IOS_REACHABILITY_v1.0.md and issue #487.
enum ConnectionProblem: Equatable {
    /// -999 (NSURLErrorCancelled): the request was superseded (a newer load/task)
    /// or the network switched mid-flight. Transient — must NOT be shown.
    case cancelled
    /// Host didn't answer. `privateLAN` = the host is an RFC-1918 home-Wi-Fi IP,
    /// so it only works on that same Wi-Fi (the off-Wi-Fi case → suggest Tailscale/Cloud).
    case cannotReach(privateLAN: Bool)
    /// LISA Cloud itself didn't answer (this phone is offline, most likely).
    case cloudUnreachable
    /// The relay has no connection from the Mac: asleep, off, LISA stopped, or
    /// phone connections turned off.
    case macOffline
    /// 401/403 — a Mac device token was rejected or revoked.
    case unauthorized
    /// An account-paired Mac no longer allows this iPhone.
    case deviceRemoved
    /// The LISA account session expired or was signed out.
    case signInRequired
    /// The Mac has remote control turned off for phones.
    case remoteControlOff
    /// The phone's clock is too far from the Mac's for a signed request.
    case clockSkew
    /// LISA Cloud has paused service (not a balance problem).
    case servicePaused
    /// Another reply is still being written on this connection.
    case busy
    /// Too many requests; try again shortly.
    case rateLimited
    /// The server speaks a newer API than this build.
    case updateRequired(Int)
    /// The server answered something this build can't read.
    case badResponse
    /// The Mac connection dropped after a request was sent.
    case interrupted
    /// The Mac's identity couldn't be verified; pairing again fixes it.
    case pairAgain
    /// Any other refusal the server explained in its own words.
    case refused(String)
    /// A non-auth HTTP error with no explanation.
    case serverError(Int)

    /// The one next step a screen offers next to the message.
    enum Action: Equatable { case useCloud, signIn, connectMac, retry }

    /// Classify an error thrown by `LisaClient` against the current config.
    static func classify(_ error: Error, config: ServerConfig) -> ConnectionProblem {
        if error is CancellationError { return .cancelled }
        if let link = error as? RemoteLinkError {
            switch link {
            case .signIn: return .signInRequired
            case .notAllowed: return .deviceRemoved
            case .macOffline: return .macOffline
            case .interrupted: return .interrupted
            case .invalidPeer, .pairingRestarted, .pairingAborted: return .pairAgain
            }
        }
        if let lisa = error as? LisaError {
            switch lisa {
            case .unsupportedAPIVersion(let version): return .updateRequired(version)
            case .decode: return .badResponse
            case .notConfigured, .secureStorage: return .refused(lisa.errorDescription ?? "")
            case .http, .server: break
            }
        }
        if let failure = error.serverFailure { return classify(failure, config: config) }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled {
            return .cancelled
        }
        // Everything else network-ish (cannotConnectToHost / timedOut /
        // networkConnectionLost / notConnectedToInternet / cannotFindHost / …) is
        // "can't reach"; qualify it by what the phone was trying to reach.
        if config.remoteMac == nil && config.scheme == "https" && SessionToken.claims(config.token) != nil {
            return .cloudUnreachable
        }
        return .cannotReach(privateLAN: config.isPrivateLAN)
    }

    /// Classify a server's non-2xx answer by its error code first, then status.
    static func classify(_ failure: ServerFailure, config: ServerConfig) -> ConnectionProblem {
        switch failure.code {
        case "clock_skew": return .clockSkew
        case "remote_control_disabled": return .remoteControlOff
        case "service_paused": return .servicePaused
        case "turn_in_progress": return .busy
        case "rate_limited": return .rateLimited
        default: break
        }
        switch failure.status {
        case 401:
            return config.usesAccountSession ? .signInRequired : .unauthorized
        case 403 where failure.code.isEmpty && failure.message == nil:
            // An older Mac's bare 403: its token no longer grants this.
            return .unauthorized
        case 429:
            return .rateLimited
        default:
            if let message = failure.message { return .refused(message) }
            return .serverError(failure.status)
        }
    }

    /// True when switching to LISA Cloud is a sensible one-tap escape (the Mac
    /// itself is unreachable — R4). Not offered for auth/server errors.
    var offersCloud: Bool {
        switch self {
        case .cannotReach, .macOffline: return true
        default: return false
        }
    }

    var action: Action? {
        switch self {
        case .cannotReach, .macOffline: return .useCloud
        case .signInRequired: return .signIn
        case .deviceRemoved, .pairAgain, .unauthorized: return .connectMac
        case .cloudUnreachable, .interrupted, .busy, .rateLimited, .serverError, .badResponse: return .retry
        default: return nil
        }
    }

    /// SF Symbol for the state (unused for `.cancelled`, which never renders).
    var icon: String {
        switch self {
        case .unauthorized, .deviceRemoved, .signInRequired, .pairAgain: return "lock.trianglebadge.exclamationmark"
        case .macOffline: return "desktopcomputer.trianglebadge.exclamationmark"
        case .clockSkew: return "clock.badge.exclamationmark"
        case .remoteControlOff: return "hand.raised"
        case .servicePaused, .busy, .rateLimited: return "hourglass"
        case .serverError, .refused, .badResponse, .updateRequired, .interrupted: return "exclamationmark.triangle"
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
        case .cloudUnreachable:
            return ("Can't reach LISA Cloud",
                    "Check that this iPhone is online, then try again.")
        case .macOffline:
            return ("Your Mac isn't connected",
                    "Wake your Mac and make sure LISA is running with phone connections on. "
                    + "It reconnects by itself once it's back online.")
        case .unauthorized:
            return ("Pairing was rejected",
                    "This device's token was revoked or expired. Re-pair from Settings — run `lisa pair` on your Mac for a fresh code.")
        case .deviceRemoved:
            return ("Your Mac removed this iPhone",
                    "Pair again from Settings → Connect your Mac, then choose Allow on your Mac.")
        case .signInRequired:
            return ("Sign in again",
                    "Your LISA session expired or was signed out. Sign in to the same account to continue — what you typed is kept.")
        case .remoteControlOff:
            return ("Remote control is off on your Mac",
                    "Your Mac doesn't accept this from a phone. Turn on remote control in LISA on your Mac to allow it.")
        case .clockSkew:
            return ("Check this iPhone's clock",
                    "The time on this iPhone is more than five minutes off. Turn on Set Automatically in Settings → General → Date & Time, then try again.")
        case .servicePaused:
            return ("LISA Cloud is paused",
                    "LISA Cloud isn't taking new requests right now. Your balance is unaffected — try again later.")
        case .busy:
            return ("Lisa is still answering",
                    "Wait for the current reply to finish, then try again.")
        case .rateLimited:
            return ("Too many requests",
                    "Wait a minute, then try again.")
        case .updateRequired(let version):
            return ("Update Lisa Pocket",
                    "This Lisa server uses API v\(version). Update Lisa Pocket from the App Store to reconnect.")
        case .badResponse:
            return ("Unexpected answer",
                    "Lisa answered something this version of Lisa Pocket can't read. Make sure both are up to date.")
        case .interrupted:
            return ("Connection interrupted",
                    "The Mac connection dropped after the request was sent. Check whether it ran before sending it again.")
        case .pairAgain:
            return ("Pair your Mac again",
                    "Lisa Pocket couldn't verify your Mac. Pair it again from Settings → Connect your Mac.")
        case .refused(let message):
            return ("Lisa couldn't do that", message)
        case .serverError(let code):
            return ("Lisa returned an error",
                    "Lisa answered with HTTP \(code). Make sure it's up to date, then try again.")
        }
    }

    /// One sentence for inline places (a chat bubble, a status line).
    var sentence: String? {
        guard let display else { return nil }
        if case .refused = self { return display.message }
        return "\(display.title). \(display.message)"
    }
}
