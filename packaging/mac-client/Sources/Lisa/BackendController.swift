//
//  BackendController.swift
//  Lisa
//
//  Owns the lifecycle of the local LISA backend (`lisa serve --web`) from the
//  Mac app's side:
//    • on launch, if the backend isn't already up, start it (auto-start);
//    • a manual start() the offline UIs (menu-bar popover, main window splash,
//      island pill) call as a fallback.
//
//  Start command resolution:
//    1. ~/.lisa/serve-command.txt — a full command line, if present (escape
//       hatch for running from source, e.g. "node /path/dist/cli.js serve --web").
//    2. otherwise `lisa serve --web --host 0.0.0.0` — resolved on the login
//       shell's PATH (covers `npm i -g @oratis/lisa` / Homebrew installs).
//
//  LAN-reachable by default (decision ②): a paired phone can reach the Mac over
//  Wi-Fi without the user remembering `--host 0.0.0.0`. This is safe only because
//  the backend is token-gated — the server REFUSES a non-loopback bind without
//  LISA_WEB_TOKEN and rejects unauthenticated LAN requests (server.ts) — so we
//  mint + persist a token (~/.lisa/config.env, 0600) and pass it in the backend's
//  environment. Loopback (the local owner) stays tokenless; pairing
//  (/api/pair/start) is loopback-only, so a LAN peer can't mint a device token.
//
//  It's launched via a login shell with nohup + disown so it fully detaches and
//  outlives both this launcher process and the app itself (the backend is a
//  service the island / heartbeat / other clients also use).
//

import AppKit
import Foundation

@MainActor
final class BackendController {
    static let shared = BackendController()
    private init() {}

    /// Posted (userInfo: ["up": Bool, "note": String?]) when a start attempt
    /// resolves, so the offline UIs can update.
    static let statusChanged = Notification.Name("ai.meetlisa.backendStatusChanged")

    private let probeURL = URL(string: "http://localhost:5757/")!
    private(set) var isStarting = false

    // MARK: - Launch auto-start

    /// If the backend isn't already responding, start it.
    func ensureRunning() {
        probe { [weak self] up in
            guard let self else { return }
            if up { self.post(up: true) } else { self.start() }
        }
    }

    // MARK: - Probe

    func probe(_ completion: @escaping (Bool) -> Void) {
        var req = URLRequest(url: probeURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        req.httpMethod = "HEAD"
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let up = (resp as? HTTPURLResponse) != nil
            DispatchQueue.main.async { completion(up) }
        }.resume()
    }

    // MARK: - Start

    /// Spawn the backend (detached) and poll until it answers. No-op while a
    /// start is already in flight.
    func start() {
        guard !isStarting else { return }
        isStarting = true

        let command = resolveCommand()
        // The default command binds 0.0.0.0; arm the token gate so the server will
        // accept it (and reject unauthenticated LAN callers). Harmless for a
        // loopback override — loopback is trusted regardless.
        let webToken = ensureWebToken()
        let logPath = lisaPath("backend.log")
        try? FileManager.default.createDirectory(
            atPath: (logPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Inherit the app's environment (HOME etc.) and inject the web token; the
        // login shell rebuilds PATH. Setting `environment` replaces it wholesale,
        // so start from the current environment rather than a bare dictionary.
        var env = ProcessInfo.processInfo.environment
        env["LISA_WEB_TOKEN"] = webToken
        proc.environment = env
        // -l: login shell (PATH has npm-global / Homebrew). nohup + & + disown:
        // fully detach so the backend survives this shell, the launcher, and the app.
        proc.arguments = ["-lc", "nohup \(command) >> '\(logPath)' 2>&1 & disown"]
        do {
            try proc.run()
        } catch {
            isStarting = false
            post(up: false, note: "spawn failed: \(error.localizedDescription)")
            return
        }
        pollUntilUp(attempts: 25)
    }

    private func pollUntilUp(attempts: Int) {
        guard attempts > 0 else {
            isStarting = false
            post(up: false, note: "timeout")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.probe { up in
                guard let self else { return }
                if up { self.isStarting = false; self.post(up: true) }
                else { self.pollUntilUp(attempts: attempts - 1) }
            }
        }
    }

    // MARK: - Helpers

    private func resolveCommand() -> String {
        // serve-command.txt is a full-control escape hatch (run from source, or
        // force a different host) — we don't touch its host.
        let override = lisaPath("serve-command.txt")
        if let txt = try? String(contentsOfFile: override, encoding: .utf8) {
            let t = txt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        // Default: bind all interfaces so a phone on the same Wi-Fi can reach it.
        // Token-gated for non-loopback callers (see start() / the header note).
        return "lisa serve --web --host 0.0.0.0"
    }

    // MARK: - Web token (arms the LAN auth gate)

    /// The web token the backend needs to accept LAN requests. Reuses an existing
    /// `LISA_WEB_TOKEN` from `~/.lisa/config.env` if present (stable across launches
    /// and shared with `lisa pair` / a manual `lisa serve`), else mints one, appends
    /// it to config.env (0600), and returns it. The phone still pairs with a separate
    /// per-device token via `lisa pair`; this just arms the gate.
    private func ensureWebToken() -> String {
        let configPath = lisaPath("config.env")
        if let existing = readEnvValue("LISA_WEB_TOKEN", from: configPath), !existing.isEmpty {
            return existing
        }
        let token = randomHexToken(bytes: 24)
        appendConfigEnvLine("LISA_WEB_TOKEN=\(token)", to: configPath)
        return token
    }

    /// Read KEY=value from a flat env file (first match), unquoting a simple value.
    private func readEnvValue(_ key: String, from path: String) -> String? {
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for raw in contents.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("\(key)=") else { continue }
            let value = String(line.dropFirst(key.count + 1))
            return value.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
        }
        return nil
    }

    /// Append a line to ~/.lisa/config.env (creating it 0600), preserving content.
    private func appendConfigEnvLine(_ line: String, to path: String) {
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var text = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        if !text.isEmpty && !text.hasSuffix("\n") { text += "\n" }
        text += line + "\n"
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    /// Cryptographically-random hex token (matches `openssl rand -hex <bytes>`).
    private func randomHexToken(bytes: Int) -> String {
        (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    private func lisaPath(_ name: String) -> String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".lisa/\(name)")
    }

    private func post(up: Bool, note: String? = nil) {
        var info: [String: Any] = ["up": up]
        if let note { info["note"] = note }
        NotificationCenter.default.post(name: BackendController.statusChanged, object: nil, userInfo: info)
    }
}
