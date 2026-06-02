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

    private let popoverWidth: CGFloat = 300

    private func makePopover() -> NSPopover {
        let p = NSPopover()
        p.behavior = .transient   // closes on click-outside
        p.delegate = self
        let vc = makePopoverContent()
        p.contentViewController = vc
        p.contentSize = vc.view.fittingSize
        return p
    }

    private func makePopoverContent() -> NSViewController {
        let pad: CGFloat = 16
        let inner = popoverWidth - pad * 2
        let offline = (ping == nil)

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.edgeInsets = NSEdgeInsets(top: pad, left: pad, bottom: pad, right: pad)

        stack.addArrangedSubview(headerView(inner: inner))

        if offline {
            stack.addArrangedSubview(wrappedLabel("Backend not running — start it:  lisa serve --web",
                                                  size: 12, color: .secondaryLabelColor, width: inner))
        } else {
            if let d = ping?.current_desire, !d.isEmpty {
                stack.addArrangedSubview(sectionView(title: "CURRENTLY WANTING", body: oneLine(d, 160), inner: inner))
            }
            if !sessions.isEmpty {
                stack.addArrangedSubview(claudeView(inner: inner))
            }
            if let t = ping?.last_idle_message_text, !t.isEmpty {
                stack.addArrangedSubview(sectionView(title: "★ LAST REFLECTION", body: oneLine(t, 160), inner: inner))
            }
        }

        stack.addArrangedSubview(buttonsView(inner: inner))

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            container.widthAnchor.constraint(equalToConstant: popoverWidth),
        ])
        let vc = NSViewController()
        vc.view = container
        return vc
    }

    // MARK: - Popover view helpers

    private func headerView(inner: CGFloat) -> NSView {
        let h = NSStackView()
        h.orientation = .horizontal
        h.alignment = .centerY
        h.spacing = 10
        h.translatesAutoresizingMaskIntoConstraints = false

        let avatar = NSImageView()
        if let path = Bundle.main.path(forResource: "MenuBarIcon", ofType: "png"),
           let img = NSImage(contentsOfFile: path) {
            avatar.image = img
        }
        avatar.imageScaling = .scaleProportionallyUpOrDown
        avatar.wantsLayer = true
        avatar.layer?.cornerRadius = 13
        avatar.layer?.masksToBounds = true
        avatar.widthAnchor.constraint(equalToConstant: 26).isActive = true
        avatar.heightAnchor.constraint(equalToConstant: 26).isActive = true

        let name = NSTextField(labelWithString: "Lisa")
        name.font = .systemFont(ofSize: 14, weight: .semibold)

        let mood = NSTextField(labelWithString: ping?.mood.map { "· \($0)" } ?? "")
        mood.font = .systemFont(ofSize: 11)
        mood.textColor = .secondaryLabelColor

        h.addArrangedSubview(avatar)
        h.addArrangedSubview(name)
        h.addArrangedSubview(mood)
        h.widthAnchor.constraint(equalToConstant: inner).isActive = true
        return h
    }

    private func sectionView(title: String, body: String, inner: CGFloat) -> NSView {
        let v = NSStackView()
        v.orientation = .vertical
        v.alignment = .leading
        v.spacing = 3
        v.translatesAutoresizingMaskIntoConstraints = false
        let t = NSTextField(labelWithString: title)
        t.font = .systemFont(ofSize: 10, weight: .semibold)
        t.textColor = .tertiaryLabelColor
        v.addArrangedSubview(t)
        v.addArrangedSubview(wrappedLabel(body, size: 12, color: .labelColor, width: inner))
        v.widthAnchor.constraint(equalToConstant: inner).isActive = true
        return v
    }

    private func claudeView(inner: CGFloat) -> NSView {
        let waiting = sessions.filter { $0.state == "waiting" }.count
        let working = sessions.filter { $0.state == "working" }.count
        let errors  = sessions.filter { $0.state == "error" }.count

        let v = NSStackView()
        v.orientation = .vertical
        v.alignment = .leading
        v.spacing = 6
        v.translatesAutoresizingMaskIntoConstraints = false
        let t = NSTextField(labelWithString: "CLAUDE CODE · \(sessions.count) ACTIVE")
        t.font = .systemFont(ofSize: 10, weight: .semibold)
        t.textColor = .tertiaryLabelColor
        v.addArrangedSubview(t)

        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 6
        let orange = NSColor(srgbRed: 1.0, green: 0.55, blue: 0.26, alpha: 1)
        let red    = NSColor(srgbRed: 1.0, green: 0.33, blue: 0.47, alpha: 1)
        if waiting > 0 { row.addArrangedSubview(chip("\(waiting) waiting", color: orange)) }
        if working > 0 { row.addArrangedSubview(chip("\(working) working", color: orange.withAlphaComponent(0.72))) }
        if errors  > 0 { row.addArrangedSubview(chip("\(errors) errored", color: red)) }
        if waiting == 0 && working == 0 && errors == 0 {
            row.addArrangedSubview(chip("idle", color: .systemGray))
        }
        v.addArrangedSubview(row)
        return v
    }

    /// A small rounded status chip (tinted background + colored label).
    private func chip(_ text: String, color: NSColor) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 11, weight: .medium)
        label.textColor = color
        label.translatesAutoresizingMaskIntoConstraints = false

        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = color.withAlphaComponent(0.14).cgColor
        box.layer?.cornerRadius = 7
        box.layer?.borderWidth = 1
        box.layer?.borderColor = color.withAlphaComponent(0.30).cgColor
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 9),
            label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -9),
            label.topAnchor.constraint(equalTo: box.topAnchor, constant: 3),
            label.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -3),
        ])
        return box
    }

    private func buttonsView(inner: CGFloat) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.distribution = .fillEqually
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        let open = NSButton(title: "Open chat", target: self, action: #selector(openWindow))
        open.bezelStyle = .rounded
        open.keyEquivalent = "\r"   // default (accent-tinted) button
        let refresh = NSButton(title: "Refresh", target: self, action: #selector(refreshFromPopover))
        refresh.bezelStyle = .rounded
        row.addArrangedSubview(open)
        row.addArrangedSubview(refresh)
        row.widthAnchor.constraint(equalToConstant: inner).isActive = true
        return row
    }

    private func wrappedLabel(_ s: String, size: CGFloat, color: NSColor, width: CGFloat) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = .systemFont(ofSize: size)
        l.textColor = color
        l.isSelectable = false
        l.preferredMaxLayoutWidth = width
        l.widthAnchor.constraint(equalToConstant: width).isActive = true
        return l
    }

    private func oneLine(_ s: String, _ maxLen: Int) -> String {
        let one = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.count > maxLen ? String(one.prefix(maxLen - 1)) + "…" : one
    }

    @objc private func openWindow() {
        bringToFront?()
        popover?.close()
    }

    @objc private func refreshFromPopover() {
        Task { @MainActor in
            await refreshOnce()
            // Rebuild popover view with fresh data + resize to fit it.
            if let p = popover, p.isShown {
                let vc = makePopoverContent()
                p.contentViewController = vc
                p.contentSize = vc.view.fittingSize
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
