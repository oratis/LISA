import Foundation
import SwiftUI
import UIKit
import UserNotifications
import LocalAuthentication
import WidgetKit

/// A roster session a deep-link wants to open (agent + sessionId).
struct PendingNav: Equatable { var agent: String; var id: String }

/// Where a `lisapocket://` deep-link points.
enum DeepLinkRoute: Equatable {
    case ignore                              // not our scheme
    case roster                              // lisapocket://roster (or unknown host)
    case session(agent: String, id: String)  // lisapocket://session?agent=&id=
}

/// Which data plane the app talks to — your own Mac, or hosted LISA Cloud.
/// One identity, two data planes (see docs/PLAN_IDENTITY_v1.0.md).
enum ConnectionMode: String, CaseIterable, Identifiable {
    case mac, cloud
    var id: String { rawValue }
    var label: String { self == .mac ? "My Mac" : "LISA Cloud" }
}

@MainActor
final class AppState: ObservableObject {
    @Published var config: ServerConfig
    @Published private(set) var client: LisaClient
    /// User's chosen data plane (My Mac vs LISA Cloud). Persisted; UX-only for now —
    /// the transport is the same scheme-aware ServerConfig either way.
    @Published var connectionMode: ConnectionMode
    /// Drives the TabView selection (0=Dispatch … 4=Settings) — deep-links set it.
    @Published var selectedTab = 0
    /// Set by a `lisapocket://session?…` deep-link; RosterView consumes + clears it.
    @Published var pendingSession: PendingNav?
    /// Optional Face ID / passcode gate over the app (token grants full control).
    @Published var biometricLockEnabled: Bool
    @Published var locked: Bool
    /// Last APNs registration outcome, shown in Settings.
    @Published var pushStatus = ""
    /// Drives the first-run onboarding cover (docs/PLAN_IOS_ONBOARDING_v1.0.md).
    @Published var showOnboarding = false
    /// Transient toast for action feedback (so a failed control/mutation — now
    /// that A1 surfaces non-2xx — lands visibly instead of in a buried status row).
    @Published var toast: ToastMessage?
    private var toastClear: Task<Void, Never>?

    /// Fire a haptic + show a brief toast. Use `ok: false` for failures.
    func notify(_ text: String, ok: Bool = true) {
        ok ? Haptics.success() : Haptics.warning()
        withAnimation { toast = ToastMessage(text: text, ok: ok) }
        toastClear?.cancel()
        toastClear = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            if !Task.isCancelled { withAnimation { toast = nil } }
        }
    }

    init() {
        let d = UserDefaults.standard
        let host = d.string(forKey: "lisa.host") ?? ""
        let storedPort = d.integer(forKey: "lisa.port")
        let scheme = d.string(forKey: "lisa.scheme") ?? "http"
        let cfg = ServerConfig(host: host, port: storedPort == 0 ? 5757 : storedPort, token: TokenStore.load(), scheme: scheme)
        self.config = cfg
        self.client = LisaClient(config: cfg)
        self.connectionMode = ConnectionMode(rawValue: d.string(forKey: "lisa.mode") ?? "") ?? .mac
        let lockOn = d.bool(forKey: "lisa.biometricLock")
        self.biometricLockEnabled = lockOn
        self.locked = lockOn && cfg.token != nil  // require unlock at launch when armed
        // Guided setup auto-opens for a brand-new (unpaired, never-onboarded) install.
        self.showOnboarding = !cfg.isConfigured && !d.bool(forKey: "lisa.onboarded")
        // The AppDelegate posts the APNs device token here once it arrives.
        NotificationCenter.default.addObserver(forName: .apnsToken, object: nil, queue: .main) { [weak self] note in
            let hex = note.object as? String
            Task { @MainActor in await self?.onApnsToken(hex) }
        }
        // A tapped push routes its lisapocket:// link through the deep-link handler.
        NotificationCenter.default.addObserver(forName: .apnsTapLink, object: nil, queue: .main) { [weak self] note in
            guard let link = note.object as? String, let url = URL(string: link) else { return }
            Task { @MainActor in self?.handleDeepLink(url) }
        }
    }

    // ── APNs registration (client half; delivery needs the Mac's APNs key) ──
    func enablePush() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else { pushStatus = "Notifications not allowed in iOS Settings."; return }
            UIApplication.shared.registerForRemoteNotifications()
            pushStatus = "Registering for push…"
        } catch {
            pushStatus = error.localizedDescription
        }
    }

    private func onApnsToken(_ hex: String?) async {
        guard let hex, !hex.isEmpty else {
            pushStatus = "APNs unavailable here (no token — e.g. the Simulator)."
            return
        }
        do {
            try await client.pushRegister(kind: "apns", target: hex, prefs: PushPrefs())
            pushStatus = "Push registered (APNs)."
        } catch {
            pushStatus = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    func setConnectionMode(_ m: ConnectionMode) {
        connectionMode = m
        UserDefaults.standard.set(m.rawValue, forKey: "lisa.mode")
    }

    func update(host: String, port: Int, token: String?, scheme: String = "http") {
        let cfg = ServerConfig(host: host, port: port, token: token, scheme: scheme)
        config = cfg
        client = LisaClient(config: cfg)
        let d = UserDefaults.standard
        d.set(host, forKey: "lisa.host")
        d.set(port, forKey: "lisa.port")
        d.set(scheme, forKey: "lisa.scheme")
        if let token, !token.isEmpty { TokenStore.save(token) } else { TokenStore.delete() }
    }

    /// Apply a pairing string (from QR / paste). Returns false if unparseable.
    func applyPairing(_ raw: String) -> Bool {
        guard let cfg = AppState.parsePairing(raw) else { return false }
        update(host: cfg.host, port: cfg.port, token: cfg.token, scheme: cfg.scheme)
        return true
    }

    /// Refresh the home-Widget snapshot independent of the Dispatch tab — it used
    /// to be written only while that tab was on screen, so the widget went stale
    /// whenever the user lived elsewhere (review A5). Called on launch + foreground.
    func refreshWidgetSnapshot() async {
        guard config.isConfigured, let s = try? await client.sessions() else { return }
        SharedStore.writeSnapshot(rosterCounts(s))
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Pure parse of a pairing string into a ServerConfig (no side effects) — so it's
    /// testable off the main actor. Accepts `lisa-pair://v1?host=&port=&token=&scheme=`,
    /// `http://host:port/?token=` (LAN Mac), or `https://host/?token=` (cloud). A
    /// literal http(s):// URL carries its own scheme; the lisa-pair:// form may pass
    /// `?scheme=`. Port defaults to 443 for https, else 5757. Requires host + token.
    nonisolated static func parsePairing(_ raw: String) -> ServerConfig? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed) else { return nil }
        let items = comps.queryItems ?? []
        func q(_ key: String) -> String? { items.first { $0.name == key }?.value }
        guard let host = q("host") ?? comps.host, !host.isEmpty,
              let token = q("token"), !token.isEmpty else { return nil }
        let urlScheme = (comps.scheme == "http" || comps.scheme == "https") ? comps.scheme : nil
        let scheme = q("scheme") ?? urlScheme ?? "http"
        let port = Int(q("port") ?? "") ?? comps.port ?? (scheme == "https" ? 443 : 5757)
        return ServerConfig(host: host, port: port, token: token, scheme: scheme)
    }

    /// Parse a LISA Cloud base URL (no token) into a ServerConfig for the Sign in
    /// with Apple flow — the token is minted by the server after sign-in, so this
    /// only needs host/scheme/port. A bare host is assumed https. `nonisolated` +
    /// pure so it's unit-testable. Returns nil if there's no host.
    nonisolated static func parseCloudBase(_ raw: String) -> ServerConfig? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard let comps = URLComponents(string: s), let host = comps.host, !host.isEmpty else { return nil }
        let scheme = comps.scheme == "http" ? "http" : "https"
        let port = comps.port ?? (scheme == "https" ? 443 : 5757)
        return ServerConfig(host: host, port: port, token: nil, scheme: scheme)
    }

    /// Exchange a verified Apple identity token at a LISA Cloud instance for its
    /// session token, then save the cloud connection. Throws on a bad cloud URL,
    /// an instance that hasn't enabled Sign in with Apple (404), or a rejected
    /// token (401). On success the connection is configured for `verifyConnection`.
    func connectCloudWithApple(baseURL raw: String, identityToken: String) async throws {
        guard let base = AppState.parseCloudBase(raw) else { throw LisaError.notConfigured }
        let token = try await LisaClient.exchangeAppleToken(base: base, identityToken: identityToken)
        update(host: base.host, port: base.port, token: token, scheme: base.scheme)
    }

    // ── first-run onboarding (docs/PLAN_IOS_ONBOARDING_v1.0.md) ──
    /// Sticky once the user finishes or skips, so the cover doesn't reappear every
    /// launch (UserDefaults "lisa.onboarded").
    private var onboarded: Bool {
        get { UserDefaults.standard.bool(forKey: "lisa.onboarded") }
        set { UserDefaults.standard.set(newValue, forKey: "lisa.onboarded") }
    }

    /// Still unpaired — drives the persistent "Finish setup" banner.
    var needsSetup: Bool { !config.isConfigured }

    /// Re-enter the flow (from the banner or Settings).
    func presentOnboarding() { showOnboarding = true }

    /// Close the flow. `paired` true means a verified connection — land on Chat
    /// (warmer than Dispatch). Either way mark onboarded so it won't auto-reappear.
    func finishOnboarding(paired: Bool) {
        onboarded = true
        showOnboarding = false
        if paired { selectedTab = 1 }
    }

    /// Probe the saved config before declaring success, so a bad token / unreachable
    /// Mac surfaces during onboarding rather than on the first dead tab. Uses the
    /// cheap authed island ping: 401/403 ⇒ token rejected, a connection error ⇒
    /// unreachable, 404 ⇒ reachable + token accepted (just an older Mac).
    func verifyConnection() async -> VerifyOutcome {
        guard config.isConfigured else { return .unreachable }
        do {
            _ = try await client.islandPing()
            return .ok
        } catch LisaError.http(let code) {
            if code == 401 || code == 403 { return .unauthorized }
            if code == 404 { return .ok }
            return .serverError(code)
        } catch {
            return .unreachable
        }
    }

    /// Route a `lisapocket://` deep-link (from a push Click or the home Widget).
    /// `lisapocket://roster` → Dispatch tab; `lisapocket://session?agent=&id=` →
    /// Dispatch tab + ask RosterView to open that session.
    func handleDeepLink(_ url: URL) {
        switch AppState.parseDeepLink(url) {
        case .ignore: return
        case .roster: selectedTab = 0
        case .session(let agent, let id):
            selectedTab = 0
            pendingSession = PendingNav(agent: agent, id: id)
        }
    }

    /// Pure parse of a deep-link into a route. `nonisolated` so it's testable off
    /// the main actor. Unknown lisapocket hosts fall back to the roster.
    nonisolated static func parseDeepLink(_ url: URL) -> DeepLinkRoute {
        guard url.scheme == "lisapocket" else { return .ignore }
        guard url.host == "session" else { return .roster }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let agent = items.first { $0.name == "agent" }?.value
        let id = items.first { $0.name == "id" }?.value
        if let agent, let id, !agent.isEmpty, !id.isEmpty {
            return .session(agent: agent, id: id)
        }
        return .roster
    }

    // ── biometric lock ──
    func setBiometricLock(_ on: Bool) {
        biometricLockEnabled = on
        UserDefaults.standard.set(on, forKey: "lisa.biometricLock")
        if !on { locked = false }
    }

    /// Re-arm the lock when the app leaves the foreground (called on background).
    func lockIfEnabled() {
        if biometricLockEnabled && config.token != nil { locked = true }
    }

    /// Prompt Face ID / Touch ID (falling back to the device passcode). If no auth
    /// is available at all, don't trap the user — just unlock.
    func unlock() async {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { locked = false; return }
        if let ok = try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Lisa Pocket"), ok {
            locked = false
        }
    }

    // ── proactive mode (autonomy on/off), mirrored from /api/autonomy/state ──
    /// Whether Lisa self-drives (idle + heartbeat) when you're away.
    @Published var proactiveEnabled = true
    /// Disables the toggle mid-flight so a double-tap can't race.
    @Published var proactiveBusy = false
    /// False when the Mac is too old to expose /api/autonomy/state (404) — the
    /// toggle then renders disabled rather than lying about a state it can't set.
    @Published var proactiveAvailable = true

    func loadProactive() async {
        do {
            proactiveEnabled = try await client.autonomyState()
            proactiveAvailable = true
        } catch LisaError.http(404) {
            proactiveAvailable = false
        } catch {
            // transient (offline / timeout) — keep the last-known state, don't flip the UI
        }
    }

    /// Optimistic flip with rollback on failure (mirrors how fire() actions behave).
    func setProactive(_ on: Bool) {
        guard !proactiveBusy else { return }
        let previous = proactiveEnabled
        proactiveEnabled = on
        proactiveBusy = true
        Task { @MainActor in
            defer { proactiveBusy = false }
            do { try await client.setAutonomyState(on) }
            catch { proactiveEnabled = previous }
        }
    }
}
