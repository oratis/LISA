import Foundation
import SwiftUI

/// A non-2xx answer and what the server said about it. Current LISA servers
/// answer `{"error":"<code>","message":"<sentence>"}`; older ones send a bare
/// status, a `reason`, or a text/plain sentence, so every field but `status`
/// may be empty.
struct ServerFailure: Equatable {
    var status: Int
    /// The body's `error` code, e.g. `quota_exhausted` or `clock_skew`. "" when none.
    var code: String = ""
    /// The body's `reason` (401s say `token_mismatch`, `account_session_required`, …).
    var reason: String = ""
    /// The server's own sentence for a person, when it sent one.
    var message: String?
    var retryAfterSec: Int?

    init(status: Int, code: String = "", reason: String = "", message: String? = nil, retryAfterSec: Int? = nil) {
        self.status = status
        self.code = code
        self.reason = reason
        self.message = message
        self.retryAfterSec = retryAfterSec
    }

    /// Parse a response body. A JSON object gives its fields; a short plain-text
    /// body is taken as the message. HTML (a proxy error page) is ignored.
    init(status: Int, body: Data, contentType: String? = nil) {
        self.init(status: status)
        if let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
            code = object["error"] as? String ?? ""
            reason = object["reason"] as? String ?? ""
            if let text = object["message"] as? String, !text.trimmed.isEmpty { message = text.trimmed }
            retryAfterSec = (object["retryAfterSec"] as? NSNumber)?.intValue
            return
        }
        let type = (contentType ?? "text/plain").lowercased()
        guard type.hasPrefix("text/plain"),
              let text = String(data: body.prefix(600), encoding: .utf8)?.trimmed,
              !text.isEmpty, !text.hasPrefix("<") else { return }
        message = text
    }

    static func from(_ response: URLResponse, body: Data) -> ServerFailure {
        let http = response as? HTTPURLResponse
        return ServerFailure(status: http?.statusCode ?? -1, body: body,
                             contentType: http?.value(forHTTPHeaderField: "Content-Type"))
    }

    /// One line for logs and diagnostics. Never includes a credential.
    var summary: String {
        var parts = ["HTTP \(status)"]
        if !code.isEmpty { parts.append(code) }
        if !reason.isEmpty { parts.append(reason) }
        return parts.joined(separator: " · ")
    }
}

extension LisaError {
    /// The HTTP failure behind this error, when a server answered non-2xx.
    var failure: ServerFailure? {
        switch self {
        case .http(let status): return ServerFailure(status: status)
        case .server(let failure): return failure
        default: return nil
        }
    }
}

extension Error {
    /// The HTTP failure behind any error `LisaClient` throws, or nil.
    var serverFailure: ServerFailure? { (self as? LisaError)?.failure }
    /// The HTTP status behind any error `LisaClient` throws, or nil.
    var httpStatus: Int? { serverFailure?.status }
}

/// Account sessions are `s1.<base64url JSON {uid,iat,exp,sv}>.<mac>`. Pocket
/// reads the claims (it never verifies them; the server does) to know when a
/// session is due for renewal and which account it belongs to.
enum SessionToken {
    struct Claims: Equatable {
        let uid: String
        let issuedAt: Date
        let expiresAt: Date
    }

    static func claims(_ token: String?) -> Claims? {
        guard let token else { return nil }
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let bytes = Data(base64Encoded: payload),
              let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let uid = object["uid"] as? String, !uid.isEmpty,
              let exp = (object["exp"] as? NSNumber)?.doubleValue else { return nil }
        let iat = (object["iat"] as? NSNumber)?.doubleValue ?? exp - 30 * 86_400_000
        return Claims(uid: uid, issuedAt: Date(timeIntervalSince1970: iat / 1000),
                      expiresAt: Date(timeIntervalSince1970: exp / 1000))
    }

    /// Past half its lifetime: the same point at which the server renews it.
    static func needsRenewal(_ claims: Claims, now: Date = Date()) -> Bool {
        let half = claims.expiresAt.timeIntervalSince(claims.issuedAt) / 2
        return now > claims.issuedAt.addingTimeInterval(half)
    }
}

extension ServerConfig {
    /// True when this connection authenticates with a LISA account session:
    /// LISA Cloud, or a Mac reached through the account relay. A 401 then means
    /// "sign in again", not "pair again".
    var usesAccountSession: Bool { remoteMac != nil || SessionToken.claims(token) != nil }
}

/// The current network path, readable from any actor. The remote transport
/// skips LAN probes while the phone is on cellular only.
enum NetworkPathState {
    private static let lock = NSLock()
    private static var cellular = false
    static var cellularOnly: Bool {
        get { lock.lock(); defer { lock.unlock() }; return cellular }
        set { lock.lock(); cellular = newValue; lock.unlock() }
    }
}

/// The last connection failures, newest first, for Settings → Connection
/// diagnostics. Holds no request bodies and no credentials.
@MainActor
final class ConnectionLog: ObservableObject {
    static let shared = ConnectionLog()
    struct Entry: Identifiable, Equatable {
        let id = UUID()
        let date: Date
        let what: String
        let detail: String
    }
    @Published private(set) var entries: [Entry] = []

    func record(_ what: String, _ error: Error) {
        if error is CancellationError { return }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        entries.insert(Entry(date: Date(), what: what, detail: Self.describe(error)), at: 0)
        if entries.count > 20 { entries.removeLast(entries.count - 20) }
    }

    func clear() { entries = [] }

    /// Record from any context; hops to the main actor.
    nonisolated static func note(_ what: String, _ error: Error) {
        Task { @MainActor in shared.record(what, error) }
    }

    nonisolated static func describe(_ error: Error) -> String {
        if let failure = error.serverFailure {
            return [failure.summary, failure.message].compactMap { $0 }.joined(separator: " — ")
        }
        if let link = error as? RemoteLinkError {
            return "\(link): \(link.errorDescription ?? "")"
        }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain { return "Network error \(ns.code): \(ns.localizedDescription)" }
        return (error as? LocalizedError)?.errorDescription ?? ns.localizedDescription
    }
}
