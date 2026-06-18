//
//  Updater.swift
//  Lisa
//
//  Lightweight, dependency-free update discovery. Asks the GitHub Releases API
//  for the latest tag, compares it to this bundle's version, and — when newer —
//  hands back the signed/notarized DMG asset (or the release page) to download.
//
//  This is deliberately NOT a Sparkle-style in-place auto-updater: it discovers
//  + opens the download, and Gatekeeper verifies the notarized DMG on install.
//  (A one-click in-place update would mean fetching + executing a new app
//  binary ourselves — the exact RCE surface we don't want to hand-roll.)
//

import AppKit

/// A newer release worth offering.
struct UpdateInfo {
    let version: String   // "0.11.0"
    let tag: String       // "v0.11.0"
    let downloadURL: URL  // DMG asset, else the release page
    let notes: String     // release body (may be empty)
}

enum UpdateCheckResult {
    case upToDate(current: String)
    case available(UpdateInfo)
    case failed(String)
}

final class Updater {
    static let shared = Updater()
    private init() {}

    /// Where the "Changelog" button goes — the branded page on the product site.
    static let changelogURL = URL(string: "https://meetlisa.ai/changelog")!
    /// Fallback when a release carries no DMG asset.
    static let releasesPage = URL(string: "https://github.com/oratis/LISA/releases/latest")!

    private let releasesAPI = URL(string: "https://api.github.com/repos/oratis/LISA/releases/latest")!
    private let lastCheckKey = "ai.meetlisa.updater.lastCheck"
    private let lastNotifiedKey = "ai.meetlisa.updater.lastNotifiedVersion"

    /// This bundle's marketing version (stamped from package.json at build time).
    var currentVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
    }

    /// Active check (from the About window / menu). Completion on the main thread.
    func check(completion: @escaping (UpdateCheckResult) -> Void) {
        var req = URLRequest(url: releasesAPI)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 12
        let finish: (UpdateCheckResult) -> Void = { r in DispatchQueue.main.async { completion(r) } }

        URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            guard let self else { return }
            if let err = err { finish(.failed(err.localizedDescription)); return }
            guard let data = data,
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let tag = json["tag_name"] as? String
            else { finish(.failed("Couldn't read the latest release.")); return }

            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: self.lastCheckKey)
            let latest = Self.stripV(tag)
            if Self.isNewer(latest, than: self.currentVersion) {
                let info = UpdateInfo(
                    version: latest,
                    tag: tag,
                    downloadURL: Self.dmgAsset(from: json) ?? Self.htmlURL(json) ?? Self.releasesPage,
                    notes: (json["body"] as? String) ?? ""
                )
                finish(.available(info))
            } else {
                finish(.upToDate(current: self.currentVersion))
            }
        }.resume()
    }

    /// Silent launch discovery: throttled to once/day, and only surfaces a given
    /// version ONCE (never nags about the same release every launch).
    func discoverInBackground(onNew: @escaping (UpdateInfo) -> Void) {
        let last = UserDefaults.standard.double(forKey: lastCheckKey)
        if last > Date().timeIntervalSince1970 - 24 * 60 * 60 { return }
        check { [weak self] result in
            guard let self, case .available(let info) = result else { return }
            if UserDefaults.standard.string(forKey: self.lastNotifiedKey) == info.version { return }
            UserDefaults.standard.set(info.version, forKey: self.lastNotifiedKey)
            onNew(info)
        }
    }

    // MARK: - helpers

    private static func stripV(_ tag: String) -> String {
        tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
    }

    private static func htmlURL(_ json: [String: Any]) -> URL? {
        (json["html_url"] as? String).flatMap(URL.init(string:))
    }

    private static func dmgAsset(from json: [String: Any]) -> URL? {
        guard let assets = json["assets"] as? [[String: Any]] else { return nil }
        for a in assets {
            if let name = a["name"] as? String, name.lowercased().hasSuffix(".dmg"),
               let u = a["browser_download_url"] as? String {
                return URL(string: u)
            }
        }
        return nil
    }

    /// Is `a` a newer version than `b`? Numeric, per dotted component; ignores a
    /// pre-release/build suffix (1.2.3-rc1 → 1.2.3). 0.10.0 > 0.9.0.
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = parse(a), pb = parse(b)
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    private static func parse(_ v: String) -> [Int] {
        let core = v.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? v
        return core.split(separator: ".").map { Int($0) ?? 0 }
    }
}
