import Foundation
import SwiftUI

/// A roster session a deep-link wants to open (agent + sessionId).
struct PendingNav: Equatable { var agent: String; var id: String }

@MainActor
final class AppState: ObservableObject {
    @Published var config: ServerConfig
    @Published private(set) var client: LisaClient
    /// Drives the TabView selection (0=Dispatch … 4=Settings) — deep-links set it.
    @Published var selectedTab = 0
    /// Set by a `lisapocket://session?…` deep-link; RosterView consumes + clears it.
    @Published var pendingSession: PendingNav?

    init() {
        let d = UserDefaults.standard
        let host = d.string(forKey: "lisa.host") ?? ""
        let storedPort = d.integer(forKey: "lisa.port")
        let cfg = ServerConfig(host: host, port: storedPort == 0 ? 5757 : storedPort, token: TokenStore.load())
        self.config = cfg
        self.client = LisaClient(config: cfg)
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
        guard url.scheme == "lisapocket" else { return }
        selectedTab = 0  // Dispatch
        guard url.host == "session" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let agent = items.first { $0.name == "agent" }?.value
        let id = items.first { $0.name == "id" }?.value
        if let agent, let id, !agent.isEmpty, !id.isEmpty {
            pendingSession = PendingNav(agent: agent, id: id)
        }
    }
}
