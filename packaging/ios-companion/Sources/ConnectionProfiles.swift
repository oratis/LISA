import Foundation

/// Public connection metadata only. Device tokens remain in per-profile Keychain accounts.
struct SavedMacProfile: Codable, Identifiable, Equatable {
    let id: String
    let host: String
    let port: Int
    let scheme: String
    let remoteMac: RemoteMacTarget?
    let requiresToken: Bool

    var name: String { remoteMac?.name ?? host }
    var credentialAccount: String { "mac.profile.\(id)" }
    func matches(_ config: ServerConfig) -> Bool {
        if let remoteMac, let other = config.remoteMac {
            return remoteMac.id == other.id && remoteMac.cloudOrigin == other.cloudOrigin
                && remoteMac.accountUID == other.accountUID
        }
        return remoteMac == nil && config.remoteMac == nil && host == config.host
            && port == config.port && scheme == config.scheme
    }
}

/// Endpoints live in preferences; credentials are isolated Keychain accounts.
/// Injected token access keeps migration and switching tests away from real secrets.
final class ConnectionProfiles {
    private let defaults: UserDefaults
    private let readToken: (String) -> String?
    private let tokenReadable: (String) -> Bool
    private let writeToken: (String, String?) -> Void

    convenience init(defaults: UserDefaults = .standard) {
        self.init(defaults: defaults, readToken: { TokenStore.load(account: $0) },
                  tokenReadable: { TokenStore.canRead(account: $0) }, writeToken: { account, token in
            if let token, !token.isEmpty { TokenStore.save(token, account: account) }
            else { TokenStore.delete(account: account) }
        })
    }

    init(defaults: UserDefaults = .standard,
         readToken: @escaping (String) -> String?,
         tokenReadable: @escaping (String) -> Bool = { _ in true },
         writeToken: @escaping (String, String?) -> Void) {
        self.defaults = defaults
        self.readToken = readToken
        self.tokenReadable = tokenReadable
        self.writeToken = writeToken
        if !defaults.bool(forKey: "lisa.profiles.migrated") {
            if let host = defaults.string(forKey: "lisa.host"), !host.isEmpty {
                guard tokenReadable("default") else { return }
                // The old picker could say Cloud while still connected to a LAN Mac.
                let old = ServerConfig(host: host, port: defaults.integer(forKey: "lisa.port"),
                                       token: readToken("default"),
                                       scheme: defaults.string(forKey: "lisa.scheme") ?? "http")
                let inferred: ConnectionMode = host == "cloud.meetlisa.ai" ? .cloud
                    : old.isPrivateLAN ? .mac
                    : ConnectionMode(rawValue: defaults.string(forKey: "lisa.mode") ?? "") ?? .mac
                let previous = defaults.string(forKey: "lisa.profiles.legacyMode")
                let mode = previous.flatMap(ConnectionMode.init(rawValue:)) ?? inferred
                defaults.set(mode.rawValue, forKey: "lisa.profiles.legacyMode")
                var migrated = old
                if migrated.port == 0 { migrated.port = migrated.scheme == "https" ? 443 : 5757 }
                if previous == nil { activeMode = mode }
                guard save(migrated, for: mode) else { return }
            }
            // Keep the legacy credential as a recovery copy; it is never read
            // after migration and is deleted on explicit sign-out/unpair.
            defaults.set(true, forKey: "lisa.profiles.migrated")
        }
        // Upgrade the previous single Mac in place. A locked Keychain leaves the
        // old profile usable and retries the catalogue migration on next launch.
        guard tokenReadable("mac") else { return }
        let mac = load(.mac)
        if mac.isConfigured && !savedMacs.contains(where: { $0.matches(mac) }) {
            _ = save(mac, for: .mac)
        }
    }

    var activeMode: ConnectionMode {
        get { ConnectionMode(rawValue: defaults.string(forKey: "lisa.mode") ?? "") ?? .cloud }
        set { defaults.set(newValue.rawValue, forKey: "lisa.mode") }
    }

    var savedMacs: [SavedMacProfile] {
        guard let data = defaults.data(forKey: "lisa.macProfiles.v1"),
              let profiles = try? JSONDecoder().decode([SavedMacProfile].self, from: data),
              profiles.count <= 32, Set(profiles.map(\.id)).count == profiles.count,
              profiles.allSatisfy({ UUID(uuidString: $0.id) != nil }) else { return [] }
        return profiles
    }

    var activeMacID: String? { savedMacs.first(where: { $0.matches(load(.mac)) })?.id }

    private func storeMacs(_ profiles: [SavedMacProfile]) {
        if let data = try? JSONEncoder().encode(profiles) {
            defaults.set(data, forKey: "lisa.macProfiles.v1")
        }
    }

    @discardableResult
    func selectMac(_ id: String) -> Bool {
        guard let profile = savedMacs.first(where: { $0.id == id }) else { return false }
        let token = readToken(profile.credentialAccount)
        guard !profile.requiresToken || token?.isEmpty == false else { return false }
        var config = ServerConfig(host: profile.host, port: profile.port,
                                  token: token, scheme: profile.scheme)
        config.remoteMac = profile.remoteMac
        return save(config, for: .mac)
    }

    /// Forgetting an inactive Mac never selects it or changes the active transport.
    /// Forgetting the current Mac leaves an empty profile, never an implicit next Mac.
    @discardableResult
    func forgetMac(_ id: String) -> Bool {
        guard let profile = savedMacs.first(where: { $0.id == id }) else { return false }
        if activeMacID == id {
            return save(ServerConfig(host: "", port: 5757, token: nil), for: .mac)
        }
        writeToken(profile.credentialAccount, nil)
        guard readToken(profile.credentialAccount) == nil else { return false }
        storeMacs(savedMacs.filter { $0.id != id })
        return true
    }

    /// Account-based Macs cannot survive sign-out or move to a different account.
    /// Direct QR/LAN connections have their own credentials and remain separate.
    func reconcileRemoteMacs(with cloud: ServerConfig) {
        let uid = SessionToken.claims(cloud.token)?.uid
        let origin = cloud.baseURL?.absoluteString
        for profile in savedMacs {
            guard let remote = profile.remoteMac else { continue }
            if uid != remote.accountUID || origin != remote.cloudOrigin {
                // Remove the metadata even while Keychain is locked: it must not
                // resurrect an account's pins on the next unlock or sign-in.
                writeToken(profile.credentialAccount, nil)
                if activeMacID == profile.id {
                    let prefix = "lisa.profile.mac."
                    defaults.set("", forKey: prefix + "host")
                    defaults.removeObject(forKey: prefix + "remoteMac")
                    writeToken("mac", nil)
                }
                storeMacs(savedMacs.filter { $0.id != profile.id })
            }
        }
    }

    func load(_ mode: ConnectionMode) -> ServerConfig {
        if !defaults.bool(forKey: "lisa.profiles.migrated"),
           mode.rawValue == defaults.string(forKey: "lisa.profiles.legacyMode"),
           let host = defaults.string(forKey: "lisa.host"), !host.isEmpty {
            let scheme = defaults.string(forKey: "lisa.scheme") ?? "http"
            let port = defaults.integer(forKey: "lisa.port")
            return ServerConfig(host: host, port: port == 0 ? (scheme == "https" ? 443 : 5757) : port,
                                token: readToken("default"), scheme: scheme)
        }
        let prefix = "lisa.profile.\(mode.rawValue)."
        let scheme = defaults.string(forKey: prefix + "scheme") ?? (mode == .cloud ? "https" : "http")
        let port = defaults.integer(forKey: prefix + "port")
        var config = ServerConfig(host: defaults.string(forKey: prefix + "host") ?? "",
                            port: port == 0 ? (scheme == "https" ? 443 : 5757) : port,
                            token: readToken(mode.rawValue), scheme: scheme)
        if mode == .mac, let data = defaults.data(forKey: prefix + "remoteMac") {
            config.remoteMac = try? JSONDecoder().decode(RemoteMacTarget.self, from: data)
        }
        return config
    }

    /// A late response must not restore a signed-out session, change origin,
    /// overwrite a later sign-in, or replace a newer renewal.
    @discardableResult
    func renewSession(_ token: String, replacing expected: ServerConfig, for mode: ConnectionMode) -> Bool {
        guard load(mode) == expected,
              let old = SessionToken.claims(expected.token), let fresh = SessionToken.claims(token),
              fresh.uid == old.uid, fresh.expiresAt > old.expiresAt else { return false }
        var renewed = expected
        renewed.token = token
        return save(renewed, for: mode)
    }

    @discardableResult
    func save(_ config: ServerConfig, for mode: ConnectionMode) -> Bool {
        guard tokenReadable(mode.rawValue) else { return false }
        let normalized = config.token?.isEmpty == false ? config.token : nil
        var catalogue = savedMacs
        var macProfile: SavedMacProfile?
        var oldProfileToken: String?
        if mode == .mac && config.isConfigured {
            let previous = catalogue.first(where: { $0.matches(config) })
            guard previous != nil || catalogue.count < 32 else { return false }
            let profile = SavedMacProfile(id: previous?.id ?? UUID().uuidString,
                host: config.host, port: config.port, scheme: config.scheme, remoteMac: config.remoteMac,
                requiresToken: normalized != nil)
            guard tokenReadable(profile.credentialAccount) else { return false }
            oldProfileToken = readToken(profile.credentialAccount)
            writeToken(profile.credentialAccount, normalized)
            guard tokenReadable(profile.credentialAccount), readToken(profile.credentialAccount) == normalized else { return false }
            macProfile = profile
        }
        writeToken(mode.rawValue, normalized)
        guard tokenReadable(mode.rawValue), readToken(mode.rawValue) == normalized else {
            if let macProfile { writeToken(macProfile.credentialAccount, oldProfileToken) }
            return false
        }
        if mode == .mac {
            if let macProfile {
                catalogue.removeAll { $0.id == macProfile.id }
                catalogue.append(macProfile)
            } else if let current = activeMacID, let previous = catalogue.first(where: { $0.id == current }) {
                writeToken(previous.credentialAccount, nil)
                // Clear metadata regardless of deletion availability, as on sign-out.
                catalogue.removeAll { $0.id == current }
            }
            storeMacs(catalogue)
        }
        let prefix = "lisa.profile.\(mode.rawValue)."
        defaults.set(config.host, forKey: prefix + "host")
        defaults.set(config.port, forKey: prefix + "port")
        defaults.set(config.scheme, forKey: prefix + "scheme")
        if let target = config.remoteMac, let data = try? JSONEncoder().encode(target) {
            defaults.set(data, forKey: prefix + "remoteMac")
        } else { defaults.removeObject(forKey: prefix + "remoteMac") }
        let ownsLegacy = mode.rawValue == defaults.string(forKey: "lisa.profiles.legacyMode")
        if ownsLegacy { defaults.set(true, forKey: "lisa.profiles.migrated") }
        if normalized == nil, ownsLegacy { writeToken("default", nil) }
        if mode == .cloud { reconcileRemoteMacs(with: config) }
        return true
    }
}
