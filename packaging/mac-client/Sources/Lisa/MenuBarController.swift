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
        NotificationCenter.default.addObserver(
            self, selector: #selector(backendStatusChanged),
            name: BackendController.statusChanged, object: nil)
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
        // sessions (ALL observed agents). Either failing means "offline".
        let pingURL = URL(string: "http://localhost:5757/api/island/ping")!
        let sessURL = URL(string: "http://localhost:5757/api/agents/sessions")!
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
            let v = NSStackView()
            v.orientation = .vertical
            v.alignment = .leading
            v.spacing = 9
            v.translatesAutoresizingMaskIntoConstraints = false
            let starting = BackendController.shared.isStarting
            v.addArrangedSubview(wrappedLabel(
                starting ? "Starting the Lisa backend…" : "The Lisa backend isn't running.",
                size: 12, color: .secondaryLabelColor, width: inner))
            let start = NSButton(title: starting ? "Starting…" : "Start Lisa backend",
                                 target: self, action: #selector(startBackend))
            start.bezelStyle = .rounded
            start.keyEquivalent = "\r"
            start.isEnabled = !starting
            v.addArrangedSubview(start)
            v.widthAnchor.constraint(equalToConstant: inner).isActive = true
            stack.addArrangedSubview(v)
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
        let t = NSTextField(labelWithString: "AGENTS · \(sessions.count) ACTIVE")
        t.font = .systemFont(ofSize: 10, weight: .semibold)
        t.textColor = .tertiaryLabelColor
        v.addArrangedSubview(t)

        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 6
        if waiting > 0 { row.addArrangedSubview(chip("\(waiting) waiting", color: Self.stateOrange)) }
        if working > 0 { row.addArrangedSubview(chip("\(working) working", color: Self.stateOrange.withAlphaComponent(0.72))) }
        if errors  > 0 { row.addArrangedSubview(chip("\(errors) errored", color: Self.stateRed)) }
        if waiting == 0 && working == 0 && errors == 0 {
            row.addArrangedSubview(chip("idle", color: .systemGray))
        }
        v.addArrangedSubview(row)

        // Per-agent rows, attention-sorted (error > waiting > working), capped.
        let rank: [String: Int] = ["error": 0, "waiting": 1, "working": 2]
        let sorted = sessions.sorted { (rank[$0.state] ?? 9) < (rank[$1.state] ?? 9) }
        let cap = 6
        for s in sorted.prefix(cap) { v.addArrangedSubview(agentRow(s, inner: inner)) }
        if sorted.count > cap {
            let more = NSTextField(labelWithString: "+\(sorted.count - cap) more")
            more.font = .systemFont(ofSize: 10)
            more.textColor = .tertiaryLabelColor
            v.addArrangedSubview(more)
        }
        return v
    }

    private static let stateOrange = NSColor(srgbRed: 1.0, green: 0.55, blue: 0.26, alpha: 1)
    private static let stateRed    = NSColor(srgbRed: 1.0, green: 0.33, blue: 0.47, alpha: 1)

    /// One agent's row: ● state-dot · kind · branch/project label, with the
    /// structural activity line beneath. Mirrors the GUI roster row.
    private func agentRow(_ s: SessionDTO, inner: CGFloat) -> NSView {
        let dotColor: NSColor = s.state == "error" ? Self.stateRed
            : (s.state == "waiting" || s.state == "working") ? Self.stateOrange : .systemGray

        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.backgroundColor = dotColor.cgColor
        dot.layer?.cornerRadius = 3.5
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 7).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 7).isActive = true

        let kind = NSTextField(labelWithString: (s.agent ?? "agent"))
        kind.font = .systemFont(ofSize: 9, weight: .semibold)
        kind.textColor = .tertiaryLabelColor

        let label = NSTextField(labelWithString: oneLine(agentLabel(s), 40))
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .labelColor
        label.lineBreakMode = .byTruncatingTail

        let top = NSStackView(views: [dot, kind, label])
        top.orientation = .horizontal
        top.spacing = 6
        top.alignment = .centerY

        let col = NSStackView(views: [top])
        col.orientation = .vertical
        col.alignment = .leading
        col.spacing = 1

        let act = agentActivity(s)
        if !act.isEmpty {
            let actLabel = NSTextField(labelWithString: oneLine(act, 52))
            actLabel.font = .systemFont(ofSize: 10)
            actLabel.textColor = .secondaryLabelColor
            actLabel.lineBreakMode = .byTruncatingTail
            col.addArrangedSubview(actLabel)
        }
        return col
    }

    /// Branch label (strip "claude/"), else project. Mirrors rosterLabel.
    private func agentLabel(_ s: SessionDTO) -> String {
        if let b = s.activity?.gitBranch, !b.isEmpty {
            return b.hasPrefix("claude/") ? String(b.dropFirst("claude/".count)) : b
        }
        return s.project ?? "agent"
    }

    /// One-line structural activity. Mirrors agent-roster.ts formatActivity.
    private func agentActivity(_ s: SessionDTO) -> String {
        guard let a = s.activity else { return "" }
        if let p = a.pendingPermission, !p.isEmpty { return "⚠ wants to run " + p }
        var bits: [String] = []
        if let e = a.lastError, !e.isEmpty { bits.append("✗ " + e) }
        var prog: [String] = []
        if let n = a.turnCount, n > 0 { prog.append("turn \(n)") }
        if let tk = a.tokens {
            let tot = (tk.input ?? 0) + (tk.output ?? 0)
            if tot > 0 { prog.append(tot >= 1000 ? "\(Int((Double(tot) / 1000).rounded()))k tok" : "\(tot) tok") }
        }
        if !prog.isEmpty { bits.append(prog.joined(separator: " ")) }
        if let c = a.lastCommandName, !c.isEmpty { bits.append("$ " + c) }
        let tool = a.lastTools?.last ?? ""
        let file = (a.filesTouched?.last).map { String($0.split(separator: "/").last ?? "") } ?? ""
        if !tool.isEmpty && !file.isEmpty { bits.append(tool + " " + file) }
        else if !tool.isEmpty { bits.append(tool) }
        else if !file.isEmpty { bits.append(file) }
        return bits.joined(separator: " · ")
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
        let col = NSStackView()
        col.orientation = .vertical
        col.alignment = .leading
        col.spacing = 8
        col.translatesAutoresizingMaskIntoConstraints = false

        // Full-width "delegate a task" — opens a small dialog to start an agent.
        let delegate = NSButton(title: "＋ Delegate a task", target: self, action: #selector(delegateTask))
        delegate.bezelStyle = .rounded
        delegate.translatesAutoresizingMaskIntoConstraints = false
        delegate.widthAnchor.constraint(equalToConstant: inner).isActive = true
        col.addArrangedSubview(delegate)

        let row = NSStackView()
        row.orientation = .horizontal
        row.distribution = .fillEqually
        row.spacing = 10
        let open = NSButton(title: "Open chat", target: self, action: #selector(openWindow))
        open.bezelStyle = .rounded
        open.keyEquivalent = "\r"   // default (accent-tinted) button
        let refresh = NSButton(title: "Refresh", target: self, action: #selector(refreshFromPopover))
        refresh.bezelStyle = .rounded
        row.addArrangedSubview(open)
        row.addArrangedSubview(refresh)
        row.widthAnchor.constraint(equalToConstant: inner).isActive = true
        col.addArrangedSubview(row)

        col.widthAnchor.constraint(equalToConstant: inner).isActive = true
        return col
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

    @objc private func startBackend() {
        BackendController.shared.start()
        // Rebuild so the button flips to "Starting…" immediately.
        if let p = popover, p.isShown {
            let vc = makePopoverContent()
            p.contentViewController = vc
            p.contentSize = vc.view.fittingSize
        }
    }

    @objc private func backendStatusChanged() {
        // Re-poll + rebuild the popover when a start attempt resolves.
        Task { @MainActor in await refreshOnce() }
        if let p = popover, p.isShown {
            let vc = makePopoverContent()
            p.contentViewController = vc
            p.contentSize = vc.view.fittingSize
        }
    }

    @objc private func refreshFromPopover() {
        Task { @MainActor in
            await refreshOnce()
            rebuildPopoverIfShown()
        }
    }

    private func rebuildPopoverIfShown() {
        if let p = popover, p.isShown {
            let vc = makePopoverContent()
            p.contentViewController = vc
            p.contentSize = vc.view.fittingSize
        }
    }

    // MARK: - Delegate a task

    /// Small modal: pick an agent (managed / claude / codex) + type a task, then
    /// POST it to the backend. (Loopback ⇒ no token needed.)
    @objc private func delegateTask() {
        popover?.close()

        let width: CGFloat = 320
        let kind = NSPopUpButton(frame: NSRect(x: 0, y: 62, width: width, height: 26), pullsDown: false)
        kind.addItems(withTitles: ["managed — Lisa runs it", "claude — real CLI (PTY)", "codex — real CLI (PTY)"])
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: width, height: 52))
        field.placeholderString = "Describe the task…"
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 96))
        accessory.addSubview(kind)
        accessory.addSubview(field)

        let alert = NSAlert()
        alert.messageText = "Delegate a task"
        alert.informativeText = "Pick an agent and describe what it should do."
        alert.accessoryView = accessory
        alert.addButton(withTitle: "Start")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let task = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return }
        let agent = ["managed", "claude", "codex"][max(0, min(2, kind.indexOfSelectedItem))]
        Task { @MainActor in await startAgent(agent: agent, task: task) }
    }

    private func startAgent(agent: String, task: String) async {
        let isManaged = (agent == "managed")
        let path = isManaged ? "/api/agents/managed/start" : "/api/agents/pty/start"
        let body: [String: Any] = isManaged ? ["task": task] : ["agent": agent, "task": task]
        let result = await Self.post(url: URL(string: "http://localhost:5757\(path)")!, json: body)
        if !result.ok {
            let a = NSAlert()
            a.messageText = "Couldn't start the agent"
            a.informativeText = result.message ?? "Request failed."
            a.runModal()
        }
        await refreshOnce()
        rebuildPopoverIfShown()
    }

    private static func post(url: URL, json: [String: Any]) async -> (ok: Bool, message: String?) {
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: json)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(code) { return (true, nil) }
            let msg = String(data: data, encoding: .utf8)
            return (false, (msg?.isEmpty == false) ? msg : "HTTP \(code)")
        } catch {
            return (false, error.localizedDescription)
        }
    }

    // MARK: - DTOs

    private struct SessionsEnvelope: Decodable {
        let sessions: [SessionDTO]
    }
    private struct SessionDTO: Decodable {
        let state: String
        var agent: String?
        var project: String?
        var activity: ActivityDTO?
    }
    private struct ActivityDTO: Decodable {
        var gitBranch: String?
        var turnCount: Int?
        var tokens: TokensDTO?
        var lastTools: [String]?
        var filesTouched: [String]?
        var lastCommandName: String?
        var lastError: String?
        var pendingPermission: String?
    }
    private struct TokensDTO: Decodable {
        var input: Int?
        var output: Int?
    }
    private struct PingDTO: Decodable {
        let online: Bool?
        let mood: String?
        let current_desire: String?
        let last_idle_message_text: String?
    }
}
