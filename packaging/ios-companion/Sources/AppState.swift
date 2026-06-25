import Foundation
import SwiftUI
import UIKit
import UserNotifications
import LocalAuthentication

/// A roster session a deep-link wants to open (agent + sessionId).
struct PendingNav: Equatable { var agent: String; var id: String }

/// Where a `lisapocket://` deep-link points.
enum DeepLinkRoute: Equatable {
    case ignore                              // not our scheme
    case roster                              // lisapocket://roster (or unknown host)
    case session(agent: String, id: String)  // lisapocket://session?agent=&id=
}

@MainActor
final class AppState: ObservableObject {
    @Published var config: ServerConfig
    @Published private(set) var client: LisaClient
    /// Drives the TabView selection (0=Dispatch … 4=Settings) — deep-links set it.
    @Published var selectedTab = 0
    /// Set by a `lisapocket://session?…` deep-link; RosterView consumes + clears it.
    @Published var pendingSession: PendingNav?
    /// Optional Face ID / passcode gate over the app (token grants full control).
    @Published var biometricLockEnabled: Bool
    @Published var locked: Bool
    /// Last APNs registration outcome, shown in Settings.
    @Published var pushStatus = ""

    init() {
        let d = UserDefaults.standard
        let host = d.string(forKey: "lisa.host") ?? ""
        let storedPort = d.integer(forKey: "lisa.port")
        let cfg = ServerConfig(host: host, port: storedPort == 0 ? 5757 : storedPort, token: TokenStore.load())
        self.config = cfg
        self.client = LisaClient(config: cfg)
        let lockOn = d.bool(forKey: "lisa.biometricLock")
        self.biometricLockEnabled = lockOn
        self.locked = lockOn && cfg.token != nil  // require unlock at launch when armed
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

    func update(host: String, port: Int, token: String?) {
        let cfg = ServerConfig(host: host, port: port, token: token)
        config = cfg
        client = LisaClient(config: cfg)
        let d = UserDefaults.standard
        d.set(host, forKey: "lisa.host")
        d.set(port, forKey: "lisa.port")
        if let token, !token.isEmpty { TokenStore.save(token) } else { TokenStore.delete() }
    }

    /// Parse a pairing string: `lisa-pair://v1?host=&port=&token=` or `http://host:port/?token=`.
    func applyPairing(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed) else { return false }
        let items = comps.queryItems ?? []
        func q(_ key: String) -> String? { items.first { $0.name == key }?.value }
        let host = q("host") ?? comps.host
        let token = q("token")
        let port = Int(q("port") ?? "") ?? comps.port ?? 5757
        guard let host, !host.isEmpty, let token, !token.isEmpty else { return false }
        update(host: host, port: port, token: token)
        return true
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
