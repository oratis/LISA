import SwiftUI

/// Live output for a PTY agent, over `GET /api/agents/pty/<id>/stream`.
///
/// The detail screen used to have a "Load output" button that fetched
/// `/output` once: to watch a build you tapped it again, and again. The server
/// has had an SSE attach stream all along — a `snapshot` frame with the current
/// tail, then a `chunk` per new burst, and an `end` frame when the agent
/// finishes — so this view follows it instead.
///
/// A snapshot always *replaces* the buffer, which is what makes reconnection
/// safe: after a dropped connection the server re-sends the whole tail rather
/// than the part we missed, so re-appending would duplicate everything.

/// Where the attach stream stands, for a status line that doesn't lie.
enum PTYStreamState: Equatable {
    case connecting
    case live
    /// Dropped; a reconnect is scheduled this many seconds out.
    case retrying(seconds: Int)
    /// The agent finished — the server sent `end` and closed. No more output.
    case ended
    /// A terminal failure we won't retry (403 from the Mac's control policy).
    case blocked(String)

    var phrase: String {
        switch self {
        case .connecting: return "connecting…"
        case .live: return "live"
        case .retrying(let s): return "disconnected — retrying in \(s)s"
        case .ended: return "finished"
        case .blocked(let why): return why
        }
    }
}

/// Pure buffer rules, so the trimming is pinned by tests rather than eyeballed.
enum PTYBuffer {
    /// Keep the tail bounded: a chatty agent can emit megabytes, and the phone
    /// only ever shows the end of it. Trim on a newline when there is one nearby
    /// so the top of the view isn't a half line.
    static let limit = 60_000

    static func appending(_ chunk: String, to text: String, limit: Int = limit) -> String {
        trimmed(text + chunk, limit: limit)
    }

    static func trimmed(_ text: String, limit: Int = limit) -> String {
        guard text.count > limit else { return text }
        let tail = String(text.suffix(limit))
        // Drop the leading partial line, but only if that costs little.
        if let nl = tail.firstIndex(of: "\n"), tail.distance(from: tail.startIndex, to: nl) < 512 {
            return String(tail[tail.index(after: nl)...])
        }
        return tail
    }
}

@MainActor
final class PTYStreamModel: ObservableObject {
    @Published private(set) var text = ""
    @Published private(set) var state: PTYStreamState = .connecting
    /// Bumped on every append so the view can scroll to the bottom.
    @Published private(set) var revision = 0

    private var task: Task<Void, Never>?

    func start(client: LisaClient, sessionId: String) {
        task?.cancel()
        state = .connecting
        task = Task { @MainActor [weak self] in
            var backoff = 1
            while !Task.isCancelled {
                var sawFrame = false
                do {
                    for try await msg in client.ptyStream(sessionId) {
                        guard let self else { return }
                        sawFrame = true
                        backoff = 1                 // healthy traffic resets the backoff
                        switch msg.type {
                        case "snapshot":
                            // Replaces, never appends — see the note at the top.
                            self.text = PTYBuffer.trimmed(msg.text ?? "")
                            self.state = .live
                            self.revision += 1
                        case "chunk":
                            self.text = PTYBuffer.appending(msg.text ?? "", to: self.text)
                            self.state = .live
                            self.revision += 1
                        case "end":
                            self.state = .ended
                            return              // the agent is done; stop reconnecting
                        default:
                            break
                        }
                    }
                } catch {
                    if case LisaError.http(403) = error {
                        // The Mac's control policy refuses remote attach — retrying
                        // would just hammer it (A8).
                        self?.state = .blocked("Remote control is disabled on this Mac — no live output.")
                        return
                    }
                    if case LisaError.http(404) = error {
                        self?.state = .blocked("This session is no longer attached on the Mac.")
                        return
                    }
                }
                if Task.isCancelled { return }
                // A clean close with no frames at all usually means the session
                // ended between the roster and here; don't spin forever on it.
                if !sawFrame && backoff >= 8 {
                    self?.state = .ended
                    return
                }
                self?.state = .retrying(seconds: backoff)
                try? await Task.sleep(nanoseconds: UInt64(backoff) * 1_000_000_000)
                backoff = min(backoff * 2, 30)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    deinit { task?.cancel() }
}

/// The live log itself: a status line plus a two-axis scroller, so a 200-column
/// build line scrolls sideways instead of wrapping into mush (or clipping).
struct PTYLiveOutput: View {
    let sessionId: String
    @EnvironmentObject var app: AppState
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = PTYStreamModel()

    private static let bottomID = "pty-bottom"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                StatusDot(color: dotColor, size: 7)
                Text(model.state.phrase).font(.caption2).foregroundStyle(Theme.tertiary)
                Spacer()
                if case .retrying = model.state {
                    Button("Reconnect now") { model.start(client: app.client, sessionId: sessionId) }
                        .font(.caption2)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Live output, \(model.state.phrase)")

            ScrollViewReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(model.text.isEmpty ? "(no output yet)" : model.text)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(model.text.isEmpty ? Theme.tertiary : Theme.text)
                            .textSelection(.enabled)
                            // No wrapping: long lines scroll horizontally instead
                            // of being folded into unreadable stripes.
                            .fixedSize(horizontal: true, vertical: true)
                        Color.clear.frame(height: 1).id(Self.bottomID)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
                .frame(height: 220)
                .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: Theme.hairline))
                // Follow the tail as output arrives, the way a terminal does.
                .onChange(of: model.revision) { _, _ in
                    withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                }
            }
            .accessibilityLabel("Agent output")
            .accessibilityValue(model.text.isEmpty ? "No output yet" : String(model.text.suffix(600)))
        }
        .task(id: sessionId) { model.start(client: app.client, sessionId: sessionId) }
        // iOS suspends SSE in the background; reattach on return so the log isn't
        // silently frozen (the same rule the roster stream follows).
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, !app.locked else { return }
            if case .ended = model.state { return }
            model.start(client: app.client, sessionId: sessionId)
        }
        .onDisappear { model.stop() }
    }

    private var dotColor: Color {
        switch model.state {
        case .live: return Theme.green
        case .connecting: return Theme.waiting
        case .retrying: return Theme.waiting
        case .ended: return Theme.idle
        case .blocked: return Theme.danger
        }
    }
}
