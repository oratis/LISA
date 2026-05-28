//
//  MenuBarController.swift
//  Lisa — Phase 3.5 of issue #29
//
//  Surfaces a small NSStatusItem in the menu bar mirroring the active
//  Claude Code session count, so the user can glance at the menu bar
//  and know "Claude wants you in 1 session" without opening the
//  island or LISA's chat GUI.
//
//  The Lisa.app process is `.regular` activation policy — it has a
//  Dock icon. Adding a menu bar item alongside is the standard Mac
//  pattern for "always-glanceable summary". Click the status item to
//  bring the main Lisa window to front.
//
//  Polls /api/claude/sessions every 10s (no SSE in Swift yet — keeps
//  this PR small). Tolerates LISA being down (shows "○").
//

import AppKit
import Foundation

@MainActor
final class MenuBarController {
    static let shared = MenuBarController()

    private var statusItem: NSStatusItem?
    private var timer: Timer?

    /// Current aggregated state, just so we don't redraw on every tick
    /// if nothing changed.
    private var lastLabel = ""

    func install(broughtToFront: @escaping () -> Void) {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.title = "○"
            button.toolTip = "Lisa · Claude Code monitor"
            button.target = self
            button.action = #selector(handleClick)
            // Stash the callback so handleClick can fire it.
            self.bringToFront = broughtToFront
        }
        statusItem = item
        start()
    }

    func uninstall() {
        timer?.invalidate()
        timer = nil
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
        }
        statusItem = nil
    }

    // MARK: - Polling

    private var bringToFront: (() -> Void)?

    private func start() {
        // Initial fetch + then every 10s.
        Task { await refreshOnce() }
        timer = Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshOnce() }
        }
    }

    private func refreshOnce() async {
        let url = URL(string: "http://localhost:5757/api/claude/sessions")!
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                applyState(.offline)
                return
            }
            let parsed = try JSONDecoder().decode(SessionsEnvelope.self, from: data)
            let summary = aggregate(parsed.sessions)
            applyState(summary)
        } catch {
            applyState(.offline)
        }
    }

    // MARK: - State → label

    private enum DisplayState: Equatable {
        case offline
        case idle
        case working(Int)
        case waiting(Int)
        case error(Int)
    }

    private func aggregate(_ sessions: [SessionDTO]) -> DisplayState {
        if sessions.isEmpty { return .idle }
        let errors  = sessions.filter { $0.state == "error" }.count
        let waiting = sessions.filter { $0.state == "waiting" }.count
        let working = sessions.filter { $0.state == "working" }.count
        if errors > 0  { return .error(errors) }
        if waiting > 0 { return .waiting(waiting) }
        if working > 0 { return .working(working) }
        return .idle
    }

    private func applyState(_ state: DisplayState) {
        guard let button = statusItem?.button else { return }
        let (label, tooltip): (String, String)
        switch state {
        case .offline:
            label = "○"
            tooltip = "Lisa · server unreachable"
        case .idle:
            label = "○"
            tooltip = "Lisa · no Claude sessions active"
        case .working(let n):
            label = "▷ \(n)"
            tooltip = "Lisa · \(n) Claude session\(n == 1 ? "" : "s") working"
        case .waiting(let n):
            label = "▶︎ \(n)"
            tooltip = "Lisa · \(n) Claude session\(n == 1 ? "" : "s") waiting for you"
        case .error(let n):
            label = "✕ \(n)"
            tooltip = "Lisa · \(n) Claude session\(n == 1 ? "" : "s") errored"
        }
        if label != lastLabel {
            button.title = label
            lastLabel = label
        }
        button.toolTip = tooltip
    }

    @objc private func handleClick() {
        bringToFront?()
    }

    // MARK: - DTOs

    private struct SessionsEnvelope: Decodable {
        let sessions: [SessionDTO]
    }
    private struct SessionDTO: Decodable {
        let state: String
        // We only need state for now; the rest of the fields exist
        // but we don't decode them to keep this small.
    }
}
