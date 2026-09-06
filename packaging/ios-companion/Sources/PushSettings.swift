import Foundation

/// Push transport choice + the pure logic behind the Notifications section.
///
/// The server has supported two delivery paths since day one (src/web/push.ts):
/// `ntfy` is a plain HTTPS POST to a topic and needs no Apple infrastructure,
/// while `apns` is inert until `LISA_APNS_*` is set on the Mac. The app only ever
/// offered a topic field buried under a separate "Enable push notifications"
/// button that answered "Push registered (APNs)" whether or not anything could
/// ever be delivered — the review's UX-12 dead end.
///
/// Everything here is deterministic and unit-tested; the view does the I/O.

/// How this iPhone wants alerts delivered.
enum PushTransport: String, CaseIterable, Identifiable, Codable {
    /// Apple Push. Needs an APNs key on the Mac; nothing arrives without one.
    case apns
    /// An ntfy topic — works today with no Apple key, read by the ntfy app.
    case ntfy

    var id: String { rawValue }
    var label: String { self == .apns ? "This iPhone (APNs)" : "ntfy topic" }
}

/// One delivery destination exactly as `GET /api/push/list` reports it. Tolerant
/// decoding: an older Mac may not send `server`, `prefs` or `createdAt`, and a
/// future one may add fields — neither should make the section fail to load.
struct PushSubscriptionDTO: Codable, Identifiable, Equatable {
    var id: String
    /// "ntfy" | "apns" — anything unknown is treated as ntfy, as the server does.
    var kind: String
    /// ntfy topic, or the APNs device token.
    var target: String
    var server: String?
    var prefs: PushPrefs?

    private enum CodingKeys: String, CodingKey { case id, kind, target, server, prefs }

    init(id: String, kind: String, target: String, server: String? = nil, prefs: PushPrefs? = nil) {
        self.id = id
        self.kind = kind
        self.target = target
        self.server = server
        self.prefs = prefs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "ntfy"
        target = (try? c.decode(String.self, forKey: .target)) ?? ""
        server = try? c.decodeIfPresent(String.self, forKey: .server)
        prefs = try? c.decodeIfPresent(PushPrefs.self, forKey: .prefs)
    }

    var transport: PushTransport { kind == "apns" ? .apns : .ntfy }
}

struct PushListResponse: Codable { var subscriptions: [PushSubscriptionDTO] }

enum PushSettings {
    /// ntfy's public server — the server-side default when a subscription carries
    /// no `server`, so the app has to agree or the two disagree about where a
    /// topic lives.
    static let defaultNtfyServer = "https://ntfy.sh"

    /// Where a topic publishes. Accepts a bare host ("ntfy.example.com"), a full
    /// base URL, or nothing at all (→ ntfy.sh). Returns nil for an empty or
    /// unusable topic so the caller can keep the button disabled.
    static func ntfyPublishURL(server: String?, topic: String) -> URL? {
        let t = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let encoded = t.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        var base = (server ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty { base = defaultNtfyServer }
        if !base.lowercased().hasPrefix("http://") && !base.lowercased().hasPrefix("https://") {
            base = "https://" + base
        }
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/\(encoded)")
    }

    /// The destination the Mac holds for this transport + target, if any. Matching
    /// on target (not just kind) is what lets the UI say "your Mac is sending to a
    /// *different* topic" instead of a falsely reassuring "registered".
    static func current(_ subs: [PushSubscriptionDTO],
                        transport: PushTransport,
                        target: String) -> PushSubscriptionDTO? {
        let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return subs.first { $0.transport == transport && $0.target == t }
    }

    /// Any destination on this transport, whatever its target — used to explain a
    /// mismatch rather than silently ignoring it.
    static func other(_ subs: [PushSubscriptionDTO],
                      transport: PushTransport,
                      target: String) -> PushSubscriptionDTO? {
        let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        return subs.first { $0.transport == transport && $0.target != t }
    }

    /// The one-line truth under the picker, built ONLY from what the Mac reported
    /// plus what iOS gave us — never from "we sent a register request, so it must
    /// work". The APNs line stays explicit that the app cannot see whether the Mac
    /// has an Apple key: /api/push/* doesn't report it, so claiming delivery works
    /// would be the same lie the review flagged.
    static func stateLine(transport: PushTransport,
                          subs: [PushSubscriptionDTO],
                          loaded: Bool,
                          apnsToken: String?,
                          ntfyTopic: String) -> String {
        guard loaded else { return "Checking what your Mac has registered…" }
        switch transport {
        case .ntfy:
            let topic = ntfyTopic.trimmingCharacters(in: .whitespacesAndNewlines)
            if topic.isEmpty {
                return "Pick any hard-to-guess topic, subscribe to it in the ntfy app, then Register. No Apple key needed."
            }
            if let sub = current(subs, transport: .ntfy, target: topic) {
                let where_ = sub.server ?? defaultNtfyServer
                return "Your Mac is sending to “\(topic)” on \(displayHost(where_)). Subscribe to that topic in the ntfy app to receive them."
            }
            if let mismatch = other(subs, transport: .ntfy, target: topic) {
                return "Your Mac is sending to a different topic (“\(mismatch.target)”). Register to switch it to “\(topic)”."
            }
            return "Not registered yet — tap Register so your Mac starts publishing to “\(topic)”."
        case .apns:
            guard let token = apnsToken, !token.isEmpty else {
                return "This iPhone hasn't been given an Apple push token yet — tap Enable. (The Simulator never gets one.)"
            }
            if current(subs, transport: .apns, target: token) != nil {
                return "This iPhone's token is registered on your Mac. Apple still only delivers if the Mac has an APNs key (LISA_APNS_*) — the app can't check that from here, so if nothing arrives, that's why. The ntfy topic works without one."
            }
            return "iOS gave this iPhone a token but your Mac doesn't have it yet — tap Enable to send it."
        }
    }

    /// "https://ntfy.sh" → "ntfy.sh" for prose.
    static func displayHost(_ base: String) -> String {
        URL(string: base)?.host ?? base
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
    }

    /// True when the toggles on screen differ from what the Mac stored, so the
    /// section can say "unsaved" instead of pretending a flipped switch took
    /// effect. Nothing registered ⇒ nothing to be out of sync with.
    static func hasUnsavedPrefs(local: PushPrefs, registered: PushPrefs?) -> Bool {
        guard let registered else { return false }
        return local != registered
    }
}

extension String {
    /// Trimmed of surrounding whitespace — topics and server URLs get pasted with
    /// stray spaces more often than not.
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Publishes a one-off test message straight to the ntfy topic. This deliberately
/// does NOT go through the Mac: ntfy publishing is an unauthenticated POST, so the
/// phone can prove "the topic works and my ntfy app is subscribed" even while the
/// Mac is asleep — and the server offers no test endpoint to call instead.
enum NtfyTester {
    enum Outcome: Equatable {
        case sent
        case badTopic
        case rejected(Int)
        case unreachable(String)
    }

    static func send(server: String?, topic: String) async -> Outcome {
        guard let url = PushSettings.ntfyPublishURL(server: server, topic: topic) else { return .badTopic }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("Lisa Pocket", forHTTPHeaderField: "Title")
        req.setValue("bell", forHTTPHeaderField: "Tags")
        req.httpBody = Data("Test notification — your ntfy topic works.".utf8)
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            return (200..<300).contains(code) ? .sent : .rejected(code)
        } catch {
            return .unreachable((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }
}
