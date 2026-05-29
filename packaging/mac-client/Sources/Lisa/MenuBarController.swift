//
//  MenuBarController.swift
//  Lisa
//
//  NSStatusItem in the menu bar. Shows the Lisa mascot face + a state
//  indicator (Claude Code active-session count + her current mood) so
//  the user can glance at the menu bar and know what's going on without
//  opening the window or hovering the island pill.
//
//  Visual:
//    [🟢 Lisa icon] [▶︎ 2]   — 2 Claude sessions waiting for you
//    [🟢 Lisa icon] [▷ 1]   — 1 session working in the background
//    [⚫ Lisa icon] [○]     — backend offline (icon desaturated)
//
//  Click → small popover showing mood + currently-wanting + a Claude
//  Code summary + an "Open Lisa" button. Cmd-click → bring the chat
//  window to front directly (skip popover).
//
//  Polls /api/island/ping + /api/claude/sessions every 10s. Tolerates
//  the server being down (shows the offline state).
//

import AppKit
import Foundation

@MainActor
final class MenuBarController: NSObject, NSPopoverDelegate {
    static let shared = MenuBarController()

    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private var popover: NSPopover?
    private var bringToFront: (() -> Void)?

    /// Last applied state, used to skip redundant button updates.
    /// `lastOffline` starts as nil to force the first applyState call
    /// to actually re-apply the icon (the install() code shows a
    /// neutral colored icon synchronously and we want refreshOnce to
    /// switch to desaturated-if-offline once it completes).
    private var lastLabel = ""
    private var lastOffline: Bool? = nil

    /// Latest data from /api/island/ping — surfaced in the popover.
    private var ping: PingDTO? = nil
    private var sessions: [SessionDTO] = []

    func install(broughtToFront: @escaping () -> Void) {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            // Order matters: set title + imagePosition FIRST so the
            // status item sizes itself for both, then assign the image.
            // (Setting image first sometimes leaves AppKit with a stale
            // layout that doesn't allocate space for the title slot.)
            button.imagePosition = .imageLeading
            button.title = ""  // empty until first poll — avoids ghost "○" with no icon
            button.toolTip = "Lisa · Claude Code monitor"
            button.target = self
            button.action = #selector(handleClick)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            self.bringToFront = broughtToFront
            // Start with the COLORED icon (assume online optimistically).
            // refreshOnce will switch to desaturated within ~4s if the
            // backend really isn't running.
            applyIcon(button: button, offline: false)
        }
        statusItem = item
        start()
    }

    func uninstall() {
        timer?.invalidate()
        timer = nil
        popover?.close()
        popover = nil
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
        }
        statusItem = nil
    }

    // MARK: - Polling

    private func start() {
        Task { await refreshOnce() }
        timer = Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshOnce() }
        }
    }

    private func refreshOnce() async {
        // Two parallel requests — ping (mood + desire + idle message) and
        // sessions (Claude Code active). Either failing means "offline".
        let pingURL = URL(string: "http://localhost:5757/api/island/ping")!
        let sessURL = URL(string: "http://localhost:5757/api/claude/sessions")!
        let cfg = URLRequest.CachePolicy.reloadIgnoringLocalCacheData

        async let pingResult: PingDTO? = await Self.fetch(PingDTO.self, url: pingURL, cachePolicy: cfg)
        async let sessResult: SessionsEnvelope? = await Self.fetch(SessionsEnvelope.self, url: sessURL, cachePolicy: cfg)

        let pingDTO  = await pingResult
        let sessions = (await sessResult)?.sessions ?? []

        self.ping = pingDTO
        self.sessions = sessions
        applyState(offline: pingDTO == nil, sessions: sessions)
    }

    private static func fetch<T: Decodable>(_: T.Type, url: URL, cachePolicy: URLRequest.CachePolicy) async -> T? {
        let req = URLRequest(url: url, cachePolicy: cachePolicy, timeoutInterval: 4)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
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

    private func applyState(offline: Bool, sessions: [SessionDTO]) {
        guard let button = statusItem?.button else { return }
        let state: DisplayState = offline ? .offline : aggregate(sessions)
        let (label, tooltip): (String, String)
        switch state {
        case .offline:
            label = " ○"
            tooltip = "Lisa · backend not running\nStart: lisa serve --web"
        case .idle:
            label = ""
            tooltip = "Lisa · no Claude sessions active"
        case .working(let n):
            label = " ▷ \(n)"
            tooltip = "Lisa · \(n) Claude session\(n == 1 ? "" : "s") working"
        case .waiting(let n):
            label = " ▶︎ \(n)"
            tooltip = "Lisa · \(n) Claude session\(n == 1 ? "" : "s") waiting for you — click for details"
        case .error(let n):
            label = " ✕ \(n)"
            tooltip = "Lisa · \(n) Claude session\(n == 1 ? "" : "s") errored"
        }
        if label != lastLabel {
            button.title = label
            lastLabel = label
        }
        if lastOffline != offline {
            applyIcon(button: button, offline: offline)
            lastOffline = offline
        }
        button.toolTip = tooltip
    }

    /// Look up the bundled Lisa face PNG and stamp it on the status button.
    /// Desaturate when offline so users get an at-a-glance "she's asleep"
    /// signal without needing to read the label.
    private func applyIcon(button: NSStatusBarButton, offline: Bool) {
        guard let path = Bundle.main.path(forResource: "MenuBarIcon", ofType: "png") else {
            FileHandle.standardError.write(
                Data("[lisa-menubar] MenuBarIcon.png NOT FOUND in bundle (Bundle.main.resourcePath=\(Bundle.main.resourcePath ?? "<nil>"))\n".utf8)
            )
            return
        }
        guard let img = NSImage(contentsOfFile: path) else {
            FileHandle.standardError.write(
                Data("[lisa-menubar] NSImage(contentsOfFile:) returned nil for \(path)\n".utf8)
            )
            return
        }
        FileHandle.standardError.write(
            Data("[lisa-menubar] loaded icon \(path) (offline=\(offline))\n".utf8)
        )
        // 18pt is the conventional menu bar icon height; AppKit picks the
        // underlying 36px pixels for retina.
        img.size = NSSize(width: 18, height: 18)
        // Important: must NOT be a template image — we want the colored
        // mascot to come through, not get tinted black/white by AppKit.
        img.isTemplate = false
        if offline {
            button.image = Self.desaturate(img) ?? img
        } else {
            button.image = img
        }
    }

    /// Convert a colored NSImage to grayscale using CoreImage. Falls back
    /// to nil on any error, letting the caller use the original image.
    private static func desaturate(_ image: NSImage) -> NSImage? {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let cg = bitmap.cgImage else { return nil }
        let ci = CIImage(cgImage: cg)
        guard let filter = CIFilter(name: "CIColorControls") else { return nil }
        filter.setValue(ci, forKey: kCIInputImageKey)
        filter.setValue(0, forKey: kCIInputSaturationKey)
        filter.setValue(-0.15, forKey: kCIInputBrightnessKey)
        guard let out = filter.outputImage,
              let cgOut = CIContext().createCGImage(out, from: out.extent) else { return nil }
        let result = NSImage(cgImage: cgOut, size: image.size)
        return result
    }

    // MARK: - Click handling

    @objc private func handleClick() {
        let event = NSApp.currentEvent
        let isRightClick = event?.type == .rightMouseUp
        let isCmdClick = event?.modifierFlags.contains(.command) == true
        if isRightClick || isCmdClick {
            // Power-user path: jump straight to the window.
            bringToFront?()
            return
        }
        togglePopover()
    }

    private func togglePopover() {
        if let p = popover, p.isShown {
            p.close()
            return
        }
        guard let button = statusItem?.button else { return }
        let p = popover ?? makePopover()
        p.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover = p
    }

    private func makePopover() -> NSPopover {
        let p = NSPopover()
        p.behavior = .transient   // closes on click-outside
        p.delegate = self
        p.contentViewController = makePopoverContent()
        p.contentSize = NSSize(width: 280, height: 220)
        return p
    }

    private func makePopoverContent() -> NSViewController {
        let vc = NSViewController()
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 280, height: 220))
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.85).cgColor

        // Compose a single multi-line label — quickest path to something
        // useful without recreating the full island UI in native code.
        let label = NSTextField(labelWithString: composePopoverText())
        label.usesSingleLineMode = false
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        label.font = NSFont.systemFont(ofSize: 12)
        label.frame = NSRect(x: 16, y: 56, width: 248, height: 148)
        label.autoresizingMask = [.width, .height]
        view.addSubview(label)

        // Bottom button strip
        let openBtn = NSButton(title: "Open chat", target: self, action: #selector(openWindow))
        openBtn.bezelStyle = .rounded
        openBtn.frame = NSRect(x: 16, y: 12, width: 120, height: 32)
        view.addSubview(openBtn)

        let refreshBtn = NSButton(title: "Refresh", target: self, action: #selector(refreshFromPopover))
        refreshBtn.bezelStyle = .rounded
        refreshBtn.frame = NSRect(x: 144, y: 12, width: 120, height: 32)
        view.addSubview(refreshBtn)

        vc.view = view
        return vc
    }

    private func composePopoverText() -> String {
        guard let ping = ping else {
            return "LISA backend offline.\n\nStart it in a terminal:\n  lisa serve --web"
        }
        var lines: [String] = []
        lines.append("Lisa · mood: \(ping.mood ?? "—")")
        if let d = ping.current_desire, !d.isEmpty {
            // Trim to one short line for the popover.
            let oneLine = d.replacingOccurrences(of: "\n", with: " ")
            let trimmed = oneLine.count > 120 ? String(oneLine.prefix(117)) + "…" : oneLine
            lines.append("")
            lines.append("Wants: \(trimmed)")
        }
        if !sessions.isEmpty {
            let waiting = sessions.filter { $0.state == "waiting" }.count
            let working = sessions.filter { $0.state == "working" }.count
            let errors  = sessions.filter { $0.state == "error" }.count
            var parts: [String] = []
            if waiting > 0 { parts.append("\(waiting) waiting") }
            if working > 0 { parts.append("\(working) working") }
            if errors > 0  { parts.append("\(errors) errored") }
            lines.append("")
            lines.append("Claude Code (\(sessions.count) active): \(parts.joined(separator: " · "))")
        }
        if let text = ping.last_idle_message_text, !text.isEmpty {
            let trimmed = text.count > 100 ? String(text.prefix(97)) + "…" : text
            lines.append("")
            lines.append("★ Last reflection: \(trimmed)")
        }
        return lines.joined(separator: "\n")
    }

    @objc private func openWindow() {
        bringToFront?()
        popover?.close()
    }

    @objc private func refreshFromPopover() {
        Task { @MainActor in
            await refreshOnce()
            // Rebuild popover view with fresh data
            if let p = popover, p.isShown {
                p.contentViewController = makePopoverContent()
            }
        }
    }

    // MARK: - DTOs

    private struct SessionsEnvelope: Decodable {
        let sessions: [SessionDTO]
    }
    private struct SessionDTO: Decodable {
        let state: String
    }
    private struct PingDTO: Decodable {
        let online: Bool?
        let mood: String?
        let current_desire: String?
        let last_idle_message_text: String?
    }
}
