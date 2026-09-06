//
//  ShellRunner.swift
//  Lisa
//
//  Runs a script in a zsh LOGIN shell (`/bin/zsh -lc`) — the only way a GUI
//  app, launched from Finder with a bare PATH, sees the user's Homebrew / npm /
//  nvm tools — and streams its combined stdout+stderr back to the main thread.
//  Used by BackendController (detect + spawn the backend) and the install
//  wizard (live `npm install -g` output).
//

import Foundation

enum ShellRunner {
    /// Outcome of a finished script. `status` is -1 when the shell itself
    /// couldn't be launched (then `output` is the reason).
    struct Result {
        let output: String
        let status: Int32
    }

    /// Start `script` under `/bin/zsh -lc`. `onOutput` receives each chunk as it
    /// arrives (ANSI-stripped, main thread); `completion` runs once, on the main
    /// actor, after the process exits and the pipe has drained. Returns the
    /// Process so a caller can terminate it (Cancel in the wizard).
    @discardableResult
    static func run(
        _ script: String,
        environment: [String: String]? = nil,
        onOutput: ((String) -> Void)? = nil,
        completion: @escaping @MainActor (Result) -> Void
    ) -> Process? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", script]
        // Inherit the app's environment (HOME, LANG, …); the login shell rebuilds
        // PATH. Setting `environment` replaces it wholesale, so start from the
        // current one rather than a bare dictionary.
        var env = ProcessInfo.processInfo.environment
        for (k, v) in environment ?? [:] { env[k] = v }
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        proc.standardInput = FileHandle.nullDevice

        let buffer = OutputBuffer()
        let reader = pipe.fileHandleForReading
        reader.readabilityHandler = { fh in
            let data = fh.availableData
            if data.isEmpty {           // EOF
                fh.readabilityHandler = nil
                return
            }
            let text = buffer.append(data)
            if let onOutput, !text.isEmpty {
                DispatchQueue.main.async { onOutput(text) }
            }
        }

        proc.terminationHandler = { p in
            // The handler can fire before the last chunk was read; drain the
            // rest synchronously (the write end is closed once the shell and any
            // child holding it have exited).
            reader.readabilityHandler = nil
            let rest = reader.readDataToEndOfFile()
            let tail = buffer.append(rest)
            if let onOutput, !tail.isEmpty {
                DispatchQueue.main.async { onOutput(tail) }
            }
            let result = Result(output: buffer.text, status: p.terminationStatus)
            Task { @MainActor in completion(result) }
        }

        do {
            try proc.run()
        } catch {
            reader.readabilityHandler = nil
            let result = Result(output: "couldn't launch /bin/zsh: \(error.localizedDescription)", status: -1)
            Task { @MainActor in completion(result) }
            return nil
        }
        return proc
    }

    /// Accumulates pipe output across threads and decodes it incrementally
    /// (a chunk can split a UTF-8 sequence; keep the undecodable tail for the
    /// next chunk). Strips ANSI escapes so npm's colours don't land in the log.
    private final class OutputBuffer: @unchecked Sendable {
        private let lock = NSLock()
        private var pending = Data()
        private var all = ""

        /// Append raw bytes; returns the newly decoded, cleaned text.
        func append(_ data: Data) -> String {
            lock.lock(); defer { lock.unlock() }
            pending.append(data)
            // Decode the longest valid prefix; hold back a partial trailing sequence.
            var cut = pending.count
            while cut > 0, String(data: pending.prefix(cut), encoding: .utf8) == nil, pending.count - cut < 4 {
                cut -= 1
            }
            guard cut > 0, let s = String(data: pending.prefix(cut), encoding: .utf8) else {
                if pending.count >= 4 {          // hopelessly invalid — decode lossily, move on
                    let s = ShellRunner.stripANSI(String(decoding: pending, as: UTF8.self))
                    pending.removeAll()
                    all += s
                    return s
                }
                return ""
            }
            pending.removeFirst(cut)
            let clean = ShellRunner.stripANSI(s)
            all += clean
            return clean
        }

        var text: String { lock.lock(); defer { lock.unlock() }; return all }
    }

    /// Remove CSI / OSC escape sequences and carriage-return progress rewrites.
    static func stripANSI(_ s: String) -> String {
        var out = s.replacingOccurrences(of: #"\u{1B}\[[0-?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: #"\u{1B}\][^\u{07}]*\u{07}"#, with: "", options: .regularExpression)
        return out.replacingOccurrences(of: "\r", with: "")
    }
}
