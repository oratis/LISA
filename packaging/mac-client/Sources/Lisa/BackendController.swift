//
//  BackendController.swift
//  Lisa
//
//  Owns the lifecycle of the local LISA backend (`lisa serve --web`) from the
//  Mac app's side:
//    • on launch (and on reopen), if the backend isn't already up, start it;
//    • a manual start() the offline UIs (menu-bar popover, main window splash,
//      island pill) call as a fallback;
//    • when a start attempt dies, `lastFailure` carries the backend's OWN error
//      line out of ~/.lisa/backend.log so the offline UIs can say why. A
//      launcher that silently fails is worse than no launcher — the user is
//      told to run a command that will fail the same way.
//
//  Start command resolution:
//    1. ~/.lisa/serve-command.txt — a full command line, if present (escape
//       hatch for running from source, e.g. "node /path/dist/cli.js serve --web").
//    2. the backend embedded in this bundle — Contents/Resources/backend/dist
//       run by Contents/Resources/node-runtime/bin/node (both staged by
//       embed-runtime.sh). This is the path for a user who only downloaded the
//       DMG: nothing installed, no Node, no npm, and the app still comes up.
//    3. otherwise `lisa serve --web --host 0.0.0.0` — resolved on the login
//       shell's PATH (covers `npm i -g @oratis/lisa` / Homebrew installs, and
//       a `swift run` dev build with no embedded backend).
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

    /// Callers waiting on the in-flight start (the install wizard, restart(),
    /// the menu bar's "Start backend"). Drained exactly once by finishStart(),
    /// which hands over the SAME classified note it stores in `lastFailure` —
    /// the wizard shows it verbatim, so "timeout" is a last resort, not the
    /// usual answer.
    private var startWaiters: [(Bool, String?) -> Void] = []

    /// Where the detached backend's stdout/stderr go. The install wizard
    /// (BackendSetupController, UX-7) offers to open it.
    var backendLogPath: String { lisaPath("backend.log") }

    /// True when ~/.lisa/serve-command.txt overrides the start command — the
    /// user runs the backend their own way, so neither the embedded backend nor
    /// the `lisa` CLI check applies and the wizard must not offer to "fix" it.
    var hasServeOverride: Bool {
        guard let txt = try? String(contentsOfFile: lisaPath("serve-command.txt"), encoding: .utf8)
        else { return false }
        return !txt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Why the last start attempt failed — the backend's OWN line from
    /// ~/.lisa/backend.log (a missing dependency, `lisa` not on PATH, the port
    /// already taken), not a generic "it didn't come up". The offline surfaces
    /// show this so a backend that dies the instant it launches is a readable
    /// failure instead of a silent one. Nil once a start succeeds.
    private(set) var lastFailure: String?

    /// backend.log size at the moment we spawned, so we only ever read what
    /// THIS attempt wrote (the log is append-only across launches).
    private var logMark: UInt64 = 0

    /// Which of the three start paths the last attempt used, so a failure can
    /// name it. "command not found" means something very different depending on
    /// whether it came from the user's own serve-command.txt override or from a
    /// build with no embedded backend.
    private enum CommandSource {
        case fileOverride   // ~/.lisa/serve-command.txt
        case embedded       // Contents/Resources/backend, run by the bundled node
        case path           // `lisa` on the login shell's PATH
    }
    private var commandSource: CommandSource = .path

    // MARK: - Launch auto-start

    /// If the backend isn't already responding, start it.
    func ensureRunning() {
        probe { [weak self] up in
            guard let self else { return }
            if up { self.post(up: true) } else { self.start() }
        }
    }

    // MARK: - Account (managed inference, B8d)

    /// Public read of a ~/.lisa/config.env value (AccountWindow uses it).
    func configEnvValue(_ key: String) -> String? {
        readEnvValue(key, from: lisaPath("config.env"))
    }

    /// Upsert KEY=value in ~/.lisa/config.env (replace the existing line or
    /// append; empty value keeps the line — the backend treats "" as unset).
    func upsertConfigEnv(_ key: String, value: String) {
        let path = lisaPath("config.env")
        var lines = ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        if let last = lines.last, last.isEmpty { lines.removeLast() }
        var replaced = false
        for i in lines.indices {
            let stripped = lines[i].trimmingCharacters(in: .whitespaces)
            let body = stripped.hasPrefix("export ") ? String(stripped.dropFirst(7)) : stripped
            if body.hasPrefix("\(key)=") {
                lines[i] = "\(key)=\(value)"
                replaced = true
                break
            }
        }
        if !replaced { lines.append("\(key)=\(value)") }
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? (lines.joined(separator: "\n") + "\n").write(toFile: path, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    /// Stop the (detached) backend and start a fresh one so config.env changes
    /// apply. The backend was launched with nohup, so we match its command line;
    /// killing only `lisa serve --web` variants keeps unrelated processes safe.
    func restart(_ completion: @escaping (Bool) -> Void) {
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kill.arguments = ["-f", "serve --web"]
        kill.terminationHandler = { _ in
            // Give the old process a beat to release the port, then hop back to
            // the main actor: the waiter list and start() are both isolated
            // there. A self-removing NotificationCenter observer would need to
            // mutate its own token after a sendable closure captured it, which
            // is a hard error under -warnings-as-errors (T-11).
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard let self else { return }
                self.startWaiters.append { up, _ in completion(up) }
                self.start()
            }
        }
        try? kill.run()
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
    func start(completion: ((Bool, String?) -> Void)? = nil) {
        if let completion { startWaiters.append(completion) }
        guard !isStarting else { return }
        isStarting = true

        let command = resolveCommand()
        // The default command binds 0.0.0.0; arm the token gate so the server will
        // accept it (and reject unauthenticated LAN callers). Harmless for a
        // loopback override — loopback is trusted regardless.
        let webToken = ensureWebToken()
        let logPath = backendLogPath
        try? FileManager.default.createDirectory(
            atPath: (logPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        logMark = logSize()
        lastFailure = nil

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
            finishStart(up: false, note: "spawn failed: \(error.localizedDescription)")
            return
        }
        pollUntilUp(attempts: 25)
    }

    private func pollUntilUp(attempts: Int) {
        guard attempts > 0 else {
            finishStart(up: false, note: crashNote() ?? "no response from localhost:5757 after 20s")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.probe { up in
                guard let self else { return }
                if up { self.finishStart(up: true); return }
                // A backend that dies on launch (missing dependency, `lisa` not
                // installed, port taken) writes why to backend.log and never
                // binds. Surface that instead of counting 20s of silence down to
                // "timeout" — but only after ~2.5s, so a slow-but-healthy start
                // is never cut short by something it logged on the way up.
                if attempts <= 22, let note = self.crashNote() {
                    self.finishStart(up: false, note: note)
                    return
                }
                self.pollUntilUp(attempts: attempts - 1)
            }
        }
    }

    /// Single exit point for a start attempt: clears the in-flight flag, records
    /// the failure reason, and notifies the offline UIs.
    private func finishStart(up: Bool, note: String? = nil) {
        isStarting = false
        let detail = up ? nil : note.map(describeFailure)
        lastFailure = detail
        let waiters = startWaiters
        startWaiters = []
        post(up: up, note: detail)
        for waiter in waiters { waiter(up, detail) }
    }

    /// Prefix a raw error with the start path it came from — the difference
    /// between "something says command not found" and "the override you wrote
    /// in ~/.lisa/serve-command.txt is what failed".
    private func describeFailure(_ note: String) -> String {
        switch commandSource {
        case .fileOverride:
            return "~/.lisa/serve-command.txt failed — " + note
        case .embedded:
            return "The bundled backend failed — " + note
        case .path:
            return "No backend found — " + note
        }
    }

    // MARK: - Crash detection

    /// The backend's own fatal line from what it appended to backend.log since
    /// this attempt spawned, or nil while it is still booting quietly.
    ///
    /// Deliberately narrow: Node refusing to load a module, the port already
    /// taken, or the login shell refusing to spawn the command at all ("zsh:1:
    /// command not found: lisa"). A broad "contains error" match would call a
    /// healthy start dead over a warning it logged on the way up.
    private func crashNote() -> String? {
        let fatal = [
            "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_REQUIRE_ESM",
            "Cannot find package", "Cannot find module",
            "command not found", "EADDRINUSE",
        ]
        var echo: String?
        for line in appendedLogLines() {
            guard line.hasPrefix("zsh:") || fatal.contains(where: { line.contains($0) })
            else { continue }
            // Node prints the offending source line ("throw new ERR_MODULE_…")
            // and a stack before the readable one ("Error [ERR_MODULE_NOT_FOUND]:
            // Cannot find package 'undici' …"). Show the message; keep the echo
            // only if no better line turns up.
            if line.hasPrefix("throw ") || line.hasPrefix("at ") {
                if echo == nil { echo = line }
                continue
            }
            return String(line.prefix(200))
        }
        return echo.map { String($0.prefix(200)) }
    }

    /// Non-empty, trimmed lines the backend wrote since `logMark`.
    private func appendedLogLines() -> [String] {
        guard let handle = FileHandle(forReadingAtPath: lisaPath("backend.log")) else { return [] }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: logMark)
            let data = try handle.readToEnd() ?? Data()
            guard let text = String(data: data, encoding: .utf8) else { return [] }
            return text
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        } catch {
            return []
        }
    }

    private func logSize() -> UInt64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: lisaPath("backend.log"))
        return (attrs?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    // MARK: - Helpers

    private func resolveCommand() -> String {
        // serve-command.txt is a full-control escape hatch (run from source, or
        // force a different host) — we don't touch its host.
        let override = lisaPath("serve-command.txt")
        if let txt = try? String(contentsOfFile: override, encoding: .utf8) {
            let t = txt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty {
                // Deliberately still wins over the embedded backend: someone who
                // wrote this file wants their own tree to run, and silently
                // swapping in the bundled copy would hide their edits.
                commandSource = .fileOverride
                return t
            }
        }
        // Everything below binds all interfaces so a phone on the same Wi-Fi can
        // reach it. Token-gated for non-loopback callers (see start() / header).
        if let embedded = embeddedCommand() {
            commandSource = .embedded
            return embedded
        }
        commandSource = .path
        return "lisa serve --web --host 0.0.0.0"
    }

    // MARK: - Embedded backend

    /// The backend shipped inside this bundle, as a ready-to-run command line,
    /// or nil when this build has none (a `swift run` dev build, or one made
    /// with LISA_SKIP_EMBED=1).
    ///
    /// Prefers the embedded Node so the app depends on nothing the user has to
    /// install; falls back to a system Node if only the JS half is present.
    private func embeddedCommand() -> String? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let cli = resources.appendingPathComponent("backend/dist/cli.js").path
        guard FileManager.default.isReadableFile(atPath: cli) else { return nil }
        guard let node = embeddedNode() ?? systemNode() else { return nil }
        return "\(shellQuote(node)) \(shellQuote(cli)) serve --web --host 0.0.0.0"
    }

    /// Contents/Resources/node-runtime/bin/node, if this build embeds one.
    private func embeddedNode() -> String? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let node = resources.appendingPathComponent("node-runtime/bin/node").path
        return FileManager.default.isExecutableFile(atPath: node) ? node : nil
    }

    /// A Node already on the machine. The login shell's PATH is not consulted
    /// here — this runs before we spawn one — so check where Homebrew and the
    /// official installer put it.
    private func systemNode() -> String? {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// POSIX single-quoting — the command is handed to `zsh -lc`, and a user
    /// can install Lisa.app under a path with spaces or quotes in it.
    private func shellQuote(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
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
    /// Tolerates a leading `export ` and a trailing ` # comment` the way the backend's
    /// own parser does (src/env.ts `parseEnv`), so a hand-edited config.env doesn't
    /// make us miss an existing token and mint a duplicate.
    private func readEnvValue(_ key: String, from path: String) -> String? {
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for raw in contents.split(separator: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") {
                line = String(line.dropFirst("export ".count)).trimmingCharacters(in: .whitespaces)
            }
            guard line.hasPrefix("\(key)=") else { continue }
            var value = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
            // Strip an inline comment, but only on an unquoted value (mirrors env.ts).
            if !value.hasPrefix("\"") && !value.hasPrefix("'"), let hash = value.firstIndex(of: "#") {
                value = String(value[..<hash]).trimmingCharacters(in: .whitespaces)
            }
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
