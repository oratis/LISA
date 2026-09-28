import Foundation

/// Session-only permission, bound to both the connection and the disclosed recipients.
/// A generation invalidates pending disclosure requests when consent is withdrawn.
struct AISharingConsent {
    private(set) var generation = UUID()
    private(set) var recipients: [String] = []
    private var server: ServerConfig?

    var isGranted: Bool { server != nil && !recipients.isEmpty }

    func allows(server: ServerConfig, recipients: [String]) -> Bool {
        isGranted && self.server == server && self.recipients == recipients
    }

    @discardableResult
    mutating func grant(server: ServerConfig, recipients: [String], isAdult: Bool,
                        generation: UUID) -> Bool {
        guard isAdult, !recipients.isEmpty, self.generation == generation else { return false }
        self.server = server
        self.recipients = recipients
        return true
    }

    mutating func revoke() {
        server = nil
        recipients = []
        generation = UUID()
    }
}
