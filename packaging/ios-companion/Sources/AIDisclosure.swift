import Foundation

// Third-party AI disclosure + consent — App Store Guideline 5.1.1(i) (Data
// Collection) and 5.1.2(i) (Data Use), the 2026-09-11 rejection of v1.2
// (submission 1f0010d4-7318-44c7-b292-90ac1d8eb248). See
// REVIEW_RESPONSE_5.1.1i.md.
//
// Apple requires four things before personal data reaches a third-party AI
// service: disclose WHAT is sent, identify WHO receives it, obtain PERMISSION
// first, and cover all of it in the privacy policy. A policy alone is
// explicitly "not sufficient" — the disclosure and the ask must be in the app.
//
// Everything here is pure (no SwiftUI, no UserDefaults, no network) so the copy
// the reviewer reads and the gate that blocks the first send are both unit
// tested — `AIConsentView` only renders what this file returns.

// ── Who receives the data ───────────────────────────────────────────────────

/// One AI service that a backend forwards a turn to. Built either from the
/// backend's own `/api/ai/disclosure` answer (authoritative) or, when that
/// route isn't there, from `AIDisclosure.fallback(for:)`.
struct AIRecipient: Equatable, Identifiable {
    var name: String
    var model: String?
    var endpoint: String?
    var region: String?
    var policyURL: URL?

    var id: String { "\(name)/\(model ?? "")/\(endpoint ?? "")" }

    init(name: String, model: String? = nil, endpoint: String? = nil,
         region: String? = nil, policyURL: URL? = nil) {
        self.name = name
        self.model = model
        self.endpoint = endpoint
        self.region = region
        self.policyURL = policyURL
    }

    init(_ dto: AIRecipientDTO) {
        self.init(name: dto.name,
                  model: dto.model.flatMap { $0.isEmpty ? nil : $0 },
                  endpoint: dto.endpoint.flatMap { $0.isEmpty ? nil : $0 },
                  region: dto.region.flatMap { $0.isEmpty ? nil : $0 },
                  policyURL: dto.policyUrl.flatMap(URL.init(string:)))
    }

    /// "glm-4.6 · open.bigmodel.cn · processed in China" — the identifying
    /// detail under the company name. Omits whatever the backend didn't report
    /// rather than inventing it.
    var detail: String {
        var parts: [String] = []
        if let model { parts.append(model) }
        if let endpoint { parts.append(endpoint) }
        if let region { parts.append("processed in \(region)") }
        return parts.joined(separator: " · ")
    }
}

// ── The disclosure the user reads ───────────────────────────────────────────

/// The full "what / who" disclosure for one destination, assembled from the
/// connection mode plus whatever the backend reported about itself.
struct AIDisclosure: Equatable {
    var mode: ConnectionMode
    var recipients: [AIRecipient]
    /// true = the backend operator's API key pays for inference (LISA Cloud);
    /// false = the key belongs to the user (their own Mac).
    var managed: Bool
    /// Set when the backend named no provider — the app says so plainly
    /// instead of implying a specific company.
    var recipientsUnknown: Bool { recipients.isEmpty }

    static let privacyPolicyURL = URL(string: "https://meetlisa.ai/privacy")!

    /// What leaves the phone. Identical in both modes — the difference is only
    /// who it reaches, which `recipients` covers.
    static let dataSent: [String] = [
        "The messages you type, and any text or image you attach to them.",
        "The earlier messages of that conversation, so the reply follows on.",
        "Notes Lisa has saved about you — her memory — when they relate to what you asked.",
        "The results of any tool Lisa runs to answer you, such as a file she read for you.",
    ]

    /// What does not. Every line here is enforced by the app, not a promise
    /// about the model providers' own handling.
    static let dataNotSent: [String] = [
        "Your contacts, photo library, calendar, location or health data.",
        "Device or advertising identifiers — the app contains no analytics, advertising or tracking SDK.",
        "Anything at all until you agree on this screen. Declining leaves your message in the box, unsent.",
    ]

    var headline: String {
        mode == .cloud
            ? "Your messages go to an AI service run by another company"
            : "Your Mac sends your messages to an AI service run by another company"
    }

    /// The one-sentence route, spelled out. This is the "who" Apple asks for —
    /// the chain, not just the endpoint the phone opens a socket to.
    var route: String {
        mode == .cloud
            ? "Lisa Pocket sends what you write to LISA Cloud, our server on Google Cloud (us-central1). LISA Cloud then forwards it to the AI company below, which generates the reply. We pay for that service with our own account."
            : "Lisa Pocket sends what you write to the Mac you paired, over your own network. Your Mac then forwards it to whichever AI company you configured there, using your own API key. We never receive it."
    }

    /// Shown in place of the recipient list when the backend named no provider
    /// (an older Mac, or one that hasn't been configured yet).
    var unknownRecipientNote: String {
        mode == .cloud
            ? "This server did not report which AI company it uses. Don't send anything you wouldn't want a third party to hold until it does."
            : "This Mac hasn't reported which AI company it is configured to use. It is whichever provider's key you set up there — check Lisa's settings on the Mac."
    }

    /// The equal-protection line Apple's 5.1.1(i) text asks for, in the app as
    /// well as the policy. Kept factual: it states what we do, and points at
    /// the recipient's own terms for what they do.
    static let protectionNote = "We do not sell your messages, use them for advertising, or share them with anyone beyond the service named above. That company handles them under its own privacy policy, linked above. Our policy lists every service we use and the protections we require of it."

    /// Build the disclosure from a backend answer, falling back per field when
    /// the backend is older than this route.
    static func from(_ dto: AIDisclosureDTO?, mode: ConnectionMode) -> AIDisclosure {
        guard let dto else { return fallback(for: mode) }
        return AIDisclosure(mode: mode,
                            recipients: dto.recipients.map(AIRecipient.init),
                            managed: dto.managed ?? (mode == .cloud))
    }

    /// What we can say without the backend: the route and the data categories
    /// are structural, the recipient isn't. Never guesses a company name.
    static func fallback(for mode: ConnectionMode) -> AIDisclosure {
        AIDisclosure(mode: mode, recipients: [], managed: mode == .cloud)
    }
}

// ── The permission ──────────────────────────────────────────────────────────

/// A recorded agreement. Stored per destination so agreeing to your own Mac
/// never silently covers LISA Cloud (or a different Mac): switching backends
/// asks again, which is the honest reading of "permission before sending".
struct AIConsentRecord: Codable, Equatable {
    var version: Int
    var destination: String
    var grantedAt: Date
}

enum AIConsent {
    /// Bump when the disclosure changes materially (a new recipient, a new data
    /// category). Every stored agreement then stops matching and is asked again.
    static let currentVersion = 1

    /// Stable id for "where this phone's messages end up". Host-scoped, so
    /// re-pairing to a different Mac re-asks; empty host still yields a usable
    /// id so a not-yet-paired install can be asked once and remembered.
    static func destination(mode: ConnectionMode, host: String) -> String {
        let h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return "\(mode.rawValue):\(h.isEmpty ? "unpaired" : h)"
    }

    /// The gate. True ⇒ nothing may be sent to an AI service yet.
    static func needsConsent(_ record: AIConsentRecord?, destination: String) -> Bool {
        guard let record else { return true }
        return record.version != currentVersion || record.destination != destination
    }
}
