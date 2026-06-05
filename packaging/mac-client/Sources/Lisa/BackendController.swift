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
//    2. otherwise `lisa serve --web` — resolved on the login shell's PATH
//       (covers `npm i -g @oratis/lisa` / Homebrew installs).
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
        let logPath = lisaPath("backend.log")
        try? FileManager.default.createDirectory(
            atPath: (logPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
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
        let override = lisaPath("serve-command.txt")
        if let txt = try? String(contentsOfFile: override, encoding: .utf8) {
            let t = txt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        return "lisa serve --web"
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
