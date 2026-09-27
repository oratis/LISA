import Foundation

/// Endpoints live in preferences; credentials are isolated Keychain accounts.
/// Injected token access keeps migration and switching tests away from real secrets.
final class ConnectionProfiles {
    private let defaults: UserDefaults
    private let readToken: (String) -> String?
    private let writeToken: (String, String?) -> Void

    init(defaults: UserDefaults = .standard,
         readToken: @escaping (String) -> String? = { TokenStore.load(account: $0) },
         writeToken: @escaping (String, String?) -> Void = { account, token in
             if let token, !token.isEmpty { TokenStore.save(token, account: account) }
             else { TokenStore.delete(account: account) }
         }) {
        self.defaults = defaults
        self.readToken = readToken
        self.writeToken = writeToken
        if !defaults.bool(forKey: "lisa.profiles.migrated") {
            if let host = defaults.string(forKey: "lisa.host"), !host.isEmpty {
                // The old picker could say Cloud while still connected to a LAN Mac.
                let old = ServerConfig(host: host, port: defaults.integer(forKey: "lisa.port"),
                                       token: readToken("default"),
                                       scheme: defaults.string(forKey: "lisa.scheme") ?? "http")
                let mode: ConnectionMode = host == "cloud.meetlisa.ai" ? .cloud
                    : old.isPrivateLAN ? .mac
                    : ConnectionMode(rawValue: defaults.string(forKey: "lisa.mode") ?? "") ?? .mac
                var migrated = old
                if migrated.port == 0 { migrated.port = migrated.scheme == "https" ? 443 : 5757 }
                activeMode = mode
                guard save(migrated, for: mode) else { return }
            }
            // Keep the legacy credential as a recovery copy; it is never read
            // after migration and is deleted on explicit sign-out/unpair.
            defaults.set(true, forKey: "lisa.profiles.migrated")
        }
    }

    var activeMode: ConnectionMode {
        get { ConnectionMode(rawValue: defaults.string(forKey: "lisa.mode") ?? "") ?? .cloud }
        set { defaults.set(newValue.rawValue, forKey: "lisa.mode") }
    }

    func load(_ mode: ConnectionMode) -> ServerConfig {
        if !defaults.bool(forKey: "lisa.profiles.migrated"), mode == activeMode,
           let host = defaults.string(forKey: "lisa.host"), !host.isEmpty {
            let scheme = defaults.string(forKey: "lisa.scheme") ?? "http"
            let port = defaults.integer(forKey: "lisa.port")
            return ServerConfig(host: host, port: port == 0 ? (scheme == "https" ? 443 : 5757) : port,
                                token: readToken("default"), scheme: scheme)
        }
        let prefix = "lisa.profile.\(mode.rawValue)."
        let scheme = defaults.string(forKey: prefix + "scheme") ?? (mode == .cloud ? "https" : "http")
        let port = defaults.integer(forKey: prefix + "port")
        return ServerConfig(host: defaults.string(forKey: prefix + "host") ?? "",
                            port: port == 0 ? (scheme == "https" ? 443 : 5757) : port,
                            token: readToken(mode.rawValue), scheme: scheme)
    }

    @discardableResult
    func save(_ config: ServerConfig, for mode: ConnectionMode) -> Bool {
        let normalized = config.token?.isEmpty == false ? config.token : nil
        writeToken(mode.rawValue, normalized)
        guard readToken(mode.rawValue) == normalized else { return false }
        let prefix = "lisa.profile.\(mode.rawValue)."
        defaults.set(config.host, forKey: prefix + "host")
        defaults.set(config.port, forKey: prefix + "port")
        defaults.set(config.scheme, forKey: prefix + "scheme")
        if normalized == nil { writeToken("default", nil) }
        return true
    }
}
