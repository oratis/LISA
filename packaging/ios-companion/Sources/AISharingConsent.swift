import Combine
import Foundation

/// What a send of user text to AI is for. The consent sheet describes different
/// data for each (a chat turn vs. an agent that also reads files on the Mac), so
/// permission is granted per purpose: allowing chat does not allow delegation.
enum AISharingPurpose: String, Hashable {
    /// A Chat-tab message.
    case chat
    /// An Agents-tab task, follow-up or session adoption sent to the Mac.
    case delegation
}

/// Session-only permission, bound to the connection, the disclosed recipients and
/// the purposes the user allowed. A generation invalidates pending disclosure
/// requests when consent is withdrawn.
struct AISharingConsent {
    private(set) var generation = UUID()
    private(set) var recipients: [String] = []
    private(set) var purposes: Set<AISharingPurpose> = []
    private var server: ServerConfig?

    var isGranted: Bool { server != nil && !recipients.isEmpty && !purposes.isEmpty }

    func isGranted(for purpose: AISharingPurpose) -> Bool { isGranted && purposes.contains(purpose) }

    func allows(server: ServerConfig, recipients: [String], purpose: AISharingPurpose) -> Bool {
        isGranted(for: purpose) && self.server == server && self.recipients == recipients
    }

    /// A grant for another connection or recipient list replaces every earlier
    /// purpose: those were allowed for a disclosure that no longer applies.
    @discardableResult
    mutating func grant(server: ServerConfig, recipients: [String], purpose: AISharingPurpose,
                        isAdult: Bool, generation: UUID) -> Bool {
        guard isAdult, !recipients.isEmpty, self.generation == generation else { return false }
        if self.server != server || self.recipients != recipients { purposes = [] }
        self.server = server
        self.recipients = recipients
        purposes.insert(purpose)
        return true
    }

    mutating func revoke() {
        server = nil
        recipients = []
        purposes = []
        generation = UUID()
    }
}

/// One immutable presentation payload avoids reading stale @State from a
/// boolean sheet on its first presentation (including an empty recipient list).
struct AISharingRequest: Identifiable {
    let id = UUID()
    let server: ServerConfig
    let recipients: [String]
    let purpose: AISharingPurpose
    let generation: UUID
    let text: String
}

/// What `AppState.checkAISharing` decided for one send.
enum AISharingCheck {
    /// The session consent matches this connection, recipients and purpose.
    case allowed(AISharingRequest)
    /// Consent is missing or was given for something else: show the sheet.
    case ask(AISharingRequest)
    /// The server gave no usable recipient list, so nothing may be sent.
    case unavailable
    /// The connection or consent changed while checking; drop the send.
    case stale
}

/// The one path from user text to an AI request: check the connection's
/// recipients against the session consent, ask when they don't match, and only
/// then run `send`. Each surface owns one and presents `request` with
/// `.aiSharingConsent(_:app:)`.
///
/// Withdrawing consent (or switching connection, which withdraws it) drops the
/// sheet and cancels the check or send in progress, even when the owning view
/// is on a tab that isn't showing.
@MainActor
final class AISharingGate: ObservableObject {
    /// Drives the consent sheet. Cleared on Allow, Cancel or withdrawal.
    @Published var request: AISharingRequest?
    /// True while checking consent or sending; callers disable their send button.
    @Published private(set) var busy = false
    /// The check or send in progress (internal so tests can await it).
    private(set) var work: Task<Void, Never>?
    private var send: (@MainActor (String) async -> Void)?
    private var attempt: UUID?
    private var withdrawal: AnyCancellable?

    /// Check consent for `purpose`, then run `send(text)` at once or after the
    /// user allows. Ignored while an earlier send is checking, asking or running.
    /// The caller keeps its text field until `send` succeeds, so Cancel keeps it.
    func submit(_ text: String, purpose: AISharingPurpose, app: AppState,
                send: @escaping @MainActor (String) async -> Void) {
        guard !busy, request == nil else { return }
        watchWithdrawal(app)
        let attempt = UUID()
        self.attempt = attempt
        self.send = send
        busy = true
        work = Task { [weak self] in
            let check = await app.checkAISharing(text, purpose: purpose)
            guard let self, self.attempt == attempt, !Task.isCancelled else { return }
            switch check {
            case .allowed(let request):
                await self.deliver(request, app: app, attempt: attempt)
            case .ask(let request):
                self.request = request
                self.busy = false
                self.work = nil
            case .unavailable, .stale:
                self.finish(attempt)
            }
        }
    }

    /// The sheet's Allow: grant for exactly what it showed, then send.
    func allow(_ request: AISharingRequest, app: AppState) {
        guard self.request?.id == request.id, let attempt else { return }
        self.request = nil
        guard app.grantAISharing(request) else { finish(attempt); return }
        busy = true
        work = Task { [weak self] in await self?.deliver(request, app: app, attempt: attempt) }
    }

    /// Drop the sheet and cancel whatever is in progress. Nothing pending is sent.
    func cancel() {
        work?.cancel()
        work = nil
        request = nil
        send = nil
        attempt = nil
        busy = false
    }

    private func deliver(_ request: AISharingRequest, app: AppState, attempt: UUID) async {
        // Recheck right before the network call: the last word is the consent
        // as it stands now, not as it stood when the check began.
        guard self.attempt == attempt, !Task.isCancelled, app.allowsAISharing(request),
              let send else { finish(attempt); return }
        await send(request.text)
        finish(attempt)
    }

    private func finish(_ attempt: UUID) {
        guard self.attempt == attempt else { return }
        work = nil
        send = nil
        self.attempt = nil
        busy = false
    }

    private func watchWithdrawal(_ app: AppState) {
        guard withdrawal == nil else { return }
        withdrawal = app.$aiConsent.map(\.generation).removeDuplicates().dropFirst()
            .sink { [weak self] _ in self?.cancel() }
    }
}
