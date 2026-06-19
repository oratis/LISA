import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var config: ServerConfig
    @Published private(set) var client: LisaClient

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
}
