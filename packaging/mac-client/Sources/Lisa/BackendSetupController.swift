//
//  BackendSetupController.swift
//  Lisa
//
//  The guided backend-install sheet (review UX-7). Until now "one-click
//  download" meant: drag Lisa.app to Applications, then open Terminal and run
//  `npm install -g @oratis/lisa` — and if `lisa` wasn't there, the app sat on a
//  20 s "Starting…" and timed out with a hint. This window closes that gap:
//
//    checking ─▶ nodeMissing / nodeTooOld  (Homebrew command + Copy, nodejs.org, Re-check)
//             ─▶ cliMissing               (Install backend: live npm output + spinner)
//                   ├─ installFailed      (permissions → the exact no-sudo fix, one click)
//                   └─ ready ─▶ starting  (lisa serve --web, as before) ─▶ closes itself
//
//  Decisions are pure (LisaSetup.BackendSetup, unit-tested); this file is the
//  AppKit + process plumbing. Opened automatically by BackendController.start()
//  when `lisa` doesn't resolve, and on demand from Lisa ▸ Set Up Backend….
//

import AppKit
import LisaSetup

@MainActor
final class BackendSetupController: NSObject, NSWindowDelegate {
    static let shared = BackendSetupController()
    private override init() { super.init() }

    /// Screen the wizard is on. `SetupState` is the pure decision; the other
    /// cases are the transient phases around it.
    private enum Phase {
        case checking
        case decided(SetupState, backendUp: Bool)
        case installing(update: Bool)
        case installFailed(InstallFailure)
        case starting
        case startFailed(note: String)
    }

    private var phase: Phase = .checking { didSet { render() } }
    private var lastReport = ToolchainReport()
    private var installProcess: Process?
    private var cancelRequested = false
    /// Auto-start once `.ready` is reached — armed by an explicit user intent
    /// (menu, a finished install) and disarmed after one attempt, so a start
    /// that keeps failing can't loop the wizard.
    private var autoStartArmed = true

    private var window: NSWindow?
    private weak var hostWindow: NSWindow?

    // ── controls (built once) ──
    private let spinner = NSProgressIndicator()
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let nodeRow = ChecklistRow(title: "Node.js \(BackendSetup.minimumNodeMajor) or newer")
    private let cliRow = ChecklistRow(title: "Lisa backend (\(BackendSetup.npmPackage))")
    private let detail = NSStackView()
    private let logScroll = NSScrollView()
    private let logView = NSTextView()
    private lazy var recheckButton = NSButton(title: "Re-check", target: self, action: #selector(recheck))
    private lazy var closeButton = NSButton(title: "Close", target: self, action: #selector(closeWindow))

    private let contentWidth: CGFloat = 540
    private let pad: CGFloat = 24
    private var inner: CGFloat { contentWidth - pad * 2 }

    // MARK: - Entry points

    /// Lisa ▸ Set Up Backend…: open (or refocus) and probe. Arms auto-start so a
    /// ready-but-stopped backend just starts.
    func presentFromMenu() {
        autoStartArmed = true
        present()
    }

    /// BackendController.start() found no `lisa` on the login shell. Open the
    /// wizard without re-arming auto-start (a finished install re-arms it).
    func presentForMissingCLI() {
        present()
    }

    private func present() {
        if window == nil { build() }
        guard let window else { return }
        if window.isVisible {
            if window.sheetParent == nil {
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
            }
            recheck()
            return
        }
        // Sheet on the chat window when it's up (the usual case); a standalone
        // window when only the menu-bar item is around.
        if let host = NSApp.windows.first(where: { $0 is MainWindow && $0.isVisible }) {
            hostWindow = host
            host.beginSheet(window) { _ in }
        } else {
            hostWindow = nil
            window.center()
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }
        recheck()
    }

    @objc private func closeWindow() {
        guard let window else { return }
        if let host = hostWindow, window.sheetParent === host {
            host.endSheet(window)
        } else {
            window.orderOut(nil)
        }
    }

    private var isInstalling: Bool {
        if case .installing = phase { return true }
        return false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Don't let a half-finished npm install get orphaned behind a closed window.
        !isInstalling
    }

    // MARK: - Probe → decide

    @objc private func recheck() {
        guard !isInstalling else { return }
        phase = .checking
        let override = BackendController.shared.hasServeOverride
        ShellRunner.run(BackendSetup.probeScript) { [weak self] result in
            guard let self else { return }
            let report = ToolchainReport.parse(result.output, hasServeOverride: override)
            self.lastReport = report
            let state = BackendSetup.decide(report)
            BackendController.shared.probe { [weak self] up in
                guard let self else { return }
                self.phase = .decided(state, backendUp: up)
                if case .ready = state, !up, self.autoStartArmed {
                    self.autoStartArmed = false
                    self.startBackend()
                }
            }
        }
    }

    // MARK: - Install / fix / update

    @objc private func installBackend() { runInstall(BackendSetup.installScript, update: false) }
    @objc private func updateBackend() { runInstall(BackendSetup.installScript, update: true) }
    @objc private func applyPermissionsFix() { runInstall(BackendSetup.permissionsFixRunScript, update: false) }

    private func runInstall(_ script: String, update: Bool) {
        guard !isInstalling else { return }
        cancelRequested = false
        clearLog()
        appendLog("$ \(script.split(separator: "\n").last.map(String.init) ?? BackendSetup.installCommand)\n")
        phase = .installing(update: update)
        // Plain, quiet npm: no colours / progress bars in the log, no funding /
        // audit banners that read like errors.
        let env = [
            "NO_COLOR": "1", "npm_config_color": "false", "npm_config_progress": "false",
            "npm_config_fund": "false", "npm_config_audit": "false",
        ]
        installProcess = ShellRunner.run(script, environment: env, onOutput: { [weak self] chunk in
            self?.appendLog(chunk)
        }, completion: { [weak self] result in
            guard let self else { return }
            self.installProcess = nil
            if self.cancelRequested {
                self.cancelRequested = false
                self.appendLog("\n(cancelled)\n")
                self.recheck()
                return
            }
            if result.status == 0 {
                self.appendLog("\n✓ done\n")
                self.autoStartArmed = true
                if update { self.restartBackend() } else { self.recheck() }
            } else {
                self.phase = .installFailed(
                    BackendSetup.classifyInstallFailure(output: result.output, exitCode: result.status))
            }
        })
    }

    @objc private func cancelInstall() {
        cancelRequested = true
        installProcess?.terminate()
    }

    // MARK: - Start / restart

    @objc private func startBackend() {
        phase = .starting
        BackendController.shared.start { [weak self] up, note in
            guard let self else { return }
            if up { self.closeWindow() } else { self.phase = .startFailed(note: note ?? "timeout") }
        }
    }

    private func restartBackend() {
        phase = .starting
        BackendController.shared.restart { [weak self] up in
            guard let self else { return }
            if up { self.closeWindow() } else { self.phase = .startFailed(note: "didn't come back after the update") }
        }
    }

    // MARK: - Misc actions

    @objc private func copyBrewNode() { copyToPasteboard(BackendSetup.brewNodeCommand) }
    @objc private func copyPermissionsFix() { copyToPasteboard(BackendSetup.permissionsFixScript) }
    @objc private func copyInstallCommand() { copyToPasteboard(BackendSetup.installCommand) }
    @objc private func openNodeDownload() { NSWorkspace.shared.open(BackendSetup.nodeDownloadURL) }
    @objc private func openHomebrew() { NSWorkspace.shared.open(BackendSetup.homebrewURL) }
    @objc private func openBackendLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: BackendController.shared.backendLogPath))
    }

    private func copyToPasteboard(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    // MARK: - Build

    private func build() {
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: contentWidth, height: 420),
                           styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.title = "Set up the Lisa backend"
        win.isReleasedWhenClosed = false
        win.delegate = self

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: pad, left: pad, bottom: pad, right: pad)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "Set up the Lisa backend")
        title.font = .systemFont(ofSize: 17, weight: .bold)
        stack.addArrangedSubview(title)
        stack.addArrangedSubview(wrapped(
            "Lisa.app is the window; the backend (`lisa serve --web`) does the thinking. It runs on Node.js and installs with one command — this walks you through it.",
            size: 12, color: .secondaryLabelColor))

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
        statusLabel.preferredMaxLayoutWidth = inner - 26
        let statusRow = NSStackView(views: [spinner, statusLabel])
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 8
        statusRow.widthAnchor.constraint(equalToConstant: inner).isActive = true
        stack.addArrangedSubview(statusRow)

        let list = NSStackView(views: [nodeRow.view, cliRow.view])
        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 6
        stack.addArrangedSubview(list)

        detail.orientation = .vertical
        detail.alignment = .leading
        detail.spacing = 8
        detail.translatesAutoresizingMaskIntoConstraints = false
        detail.widthAnchor.constraint(equalToConstant: inner).isActive = true
        stack.addArrangedSubview(detail)

        // Live install log — hidden until an install runs.
        logView.isEditable = false
        logView.isRichText = false
        logView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        logView.textColor = .labelColor
        logView.isVerticallyResizable = true
        logView.isHorizontallyResizable = false
        logView.autoresizingMask = [.width]
        logView.textContainer?.widthTracksTextView = true
        logView.textContainer?.containerSize = NSSize(width: inner, height: .greatestFiniteMagnitude)
        logView.minSize = NSSize(width: 0, height: 0)
        logView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        logScroll.documentView = logView
        logScroll.hasVerticalScroller = true
        logScroll.borderType = .bezelBorder
        logScroll.translatesAutoresizingMaskIntoConstraints = false
        logScroll.heightAnchor.constraint(equalToConstant: 150).isActive = true
        logScroll.widthAnchor.constraint(equalToConstant: inner).isActive = true
        logScroll.isHidden = true
        stack.addArrangedSubview(logScroll)

        // The manual path stays visible as the fallback — same words as before.
        stack.addArrangedSubview(wrapped(
            "Prefer the terminal? Run `\(BackendSetup.installCommand)` once, then `\(BackendSetup.manualServeCommand)` — this window only does that for you.",
            size: 11, color: .tertiaryLabelColor))

        recheckButton.bezelStyle = .rounded
        closeButton.bezelStyle = .rounded
        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.translatesAutoresizingMaskIntoConstraints = false
        buttons.addView(recheckButton, in: .leading)
        buttons.addView(closeButton, in: .trailing)
        buttons.widthAnchor.constraint(equalToConstant: inner).isActive = true
        stack.addArrangedSubview(buttons)

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            container.widthAnchor.constraint(equalToConstant: contentWidth),
        ])
        win.contentView = container
        window = win
    }

    // MARK: - Render

    private func render() {
        guard window != nil else { return }
        for v in detail.arrangedSubviews {
            detail.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        var busy = false
        switch phase {
        case .checking:
            busy = true
            statusLabel.stringValue = "Checking this Mac for Node.js and the Lisa backend…"
            nodeRow.set(.pending, detail: "")
            cliRow.set(.pending, detail: "")

        case .decided(let state, let up):
            statusLabel.stringValue = state.summary + (up ? " The backend is running." : "")
            renderChecklist(state)
            renderDecided(state, backendUp: up)

        case .installing(let update):
            busy = true
            statusLabel.stringValue = update
                ? "Updating the Lisa backend… (output below)"
                : "Installing the Lisa backend — a minute or two; npm's output shows below."
            cliRow.set(.pending, detail: update ? "updating" : "installing")
            logScroll.isHidden = false
            detail.addArrangedSubview(button("Cancel", #selector(cancelInstall)))

        case .installFailed(let failure):
            statusLabel.stringValue = failure.title
            cliRow.set(.fail, detail: "install failed")
            logScroll.isHidden = false
            renderFailure(failure)

        case .starting:
            busy = true
            statusLabel.stringValue = "Starting the backend (\(BackendSetup.manualServeCommand))…"
            cliRow.set(.ok, detail: lastReport.lisaVersion.map { "v\($0)" } ?? "installed")

        case .startFailed(let note):
            statusLabel.stringValue = "The backend didn't come up (\(note))."
            detail.addArrangedSubview(wrapped(
                "~/.lisa/backend.log has the reason — usually a missing API key or a port already in use. Fix that, then try again.",
                size: 12, color: .secondaryLabelColor))
            detail.addArrangedSubview(row(button("Open backend.log", #selector(openBackendLog)),
                                          button("Try again", #selector(startBackend), primary: true)))
        }
        if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        recheckButton.isEnabled = !busy
        closeButton.isEnabled = !isInstalling
        resizeToFit()
    }

    private func renderChecklist(_ state: SetupState) {
        switch state {
        case .ready(let v):
            nodeRow.set(.ok, detail: lastReport.nodeVersion ?? (lastReport.hasServeOverride ? "custom serve command" : "found"))
            cliRow.set(.ok, detail: v.map { "v\($0)" } ?? (lastReport.hasServeOverride ? "custom serve command" : "installed"))
        case .nodeMissing:
            nodeRow.set(.fail, detail: "not found on your login shell's PATH")
            cliRow.set(.pending, detail: "needs Node.js first")
        case .nodeTooOld(let found, _):
            nodeRow.set(.fail, detail: "\(found) — \(BackendSetup.minimumNodeMajor)+ required")
            cliRow.set(.pending, detail: "needs a newer Node.js first")
        case .cliMissing(let node):
            nodeRow.set(.ok, detail: node)
            cliRow.set(.fail, detail: "not installed")
        }
    }

    private func renderDecided(_ state: SetupState, backendUp: Bool) {
        switch state {
        case .ready:
            if backendUp {
                detail.addArrangedSubview(wrapped("Nothing to do. You can pull the latest backend release from here any time.",
                                                  size: 12, color: .secondaryLabelColor))
                detail.addArrangedSubview(button("Update backend", #selector(updateBackend)))
            } else {
                detail.addArrangedSubview(row(button("Start backend", #selector(startBackend), primary: true),
                                              button("Update backend", #selector(updateBackend))))
            }
        case .nodeMissing(let brew), .nodeTooOld(_, let brew):
            renderNodeOptions(brewAvailable: brew)
        case .cliMissing:
            detail.addArrangedSubview(wrapped("One command installs it globally with npm; the output shows here as it runs. Lisa starts on its own when it's done.",
                                              size: 12, color: .secondaryLabelColor))
            detail.addArrangedSubview(row(button("Install backend", #selector(installBackend), primary: true),
                                          button("Copy command", #selector(copyInstallCommand))))
        }
    }

    /// Two ways to get Node.js, then Re-check. Homebrew first when it's present.
    private func renderNodeOptions(brewAvailable: Bool) {
        detail.addArrangedSubview(wrapped("Install Node.js first — either way works — then click Re-check:",
                                          size: 12, color: .secondaryLabelColor))
        detail.addArrangedSubview(sectionLabel(brewAvailable ? "1 · With Homebrew (in Terminal)" : "1 · With Homebrew"))
        detail.addArrangedSubview(row(codeBox(BackendSetup.brewNodeCommand), button("Copy", #selector(copyBrewNode))))
        if !brewAvailable {
            detail.addArrangedSubview(row(
                wrapped("Homebrew isn't installed on this Mac — get it from brew.sh, or use the download below.",
                        size: 11, color: .tertiaryLabelColor, width: inner - 110),
                button("Open brew.sh", #selector(openHomebrew))))
        }
        detail.addArrangedSubview(sectionLabel("2 · Download the installer"))
        detail.addArrangedSubview(button("Download Node.js from nodejs.org", #selector(openNodeDownload)))
    }

    private func renderFailure(_ failure: InstallFailure) {
        detail.addArrangedSubview(wrapped(failure.advice, size: 12, color: .secondaryLabelColor))
        switch failure {
        case .permissions:
            detail.addArrangedSubview(codeBox(BackendSetup.permissionsFixScript))
            detail.addArrangedSubview(row(button("Apply fix and retry", #selector(applyPermissionsFix), primary: true),
                                          button("Copy fix", #selector(copyPermissionsFix))))
        case .network, .unknown:
            detail.addArrangedSubview(button("Retry install", #selector(installBackend), primary: true))
        case .nodeTooOld:
            renderNodeOptions(brewAvailable: lastReport.brewPath != nil)
        }
    }

    // MARK: - Log

    private func clearLog() {
        logView.textStorage?.setAttributedString(NSAttributedString(string: ""))
    }

    private func appendLog(_ text: String) {
        guard let storage = logView.textStorage else { return }
        storage.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.labelColor,
        ]))
        logView.scrollToEndOfDocument(nil)
    }

    // MARK: - View helpers

    private func resizeToFit() {
        guard let window, let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        let height = content.fittingSize.height
        window.setContentSize(NSSize(width: contentWidth, height: height))
    }

    private func wrapped(_ s: String, size: CGFloat, color: NSColor, width: CGFloat? = nil) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = .systemFont(ofSize: size)
        l.textColor = color
        l.isSelectable = false
        let w = width ?? inner
        l.preferredMaxLayoutWidth = w
        l.translatesAutoresizingMaskIntoConstraints = false
        l.widthAnchor.constraint(equalToConstant: w).isActive = true
        return l
    }

    private func sectionLabel(_ s: String) -> NSTextField {
        let l = NSTextField(labelWithString: s)
        l.font = .systemFont(ofSize: 11, weight: .semibold)
        l.textColor = .secondaryLabelColor
        return l
    }

    private func button(_ title: String, _ action: Selector, primary: Bool = false) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        if primary { b.keyEquivalent = "\r" }
        return b
    }

    private func row(_ views: NSView...) -> NSStackView {
        let r = NSStackView(views: views)
        r.orientation = .horizontal
        r.alignment = .centerY
        r.spacing = 8
        return r
    }

    /// A selectable, monospaced command box the user can read and copy from.
    private func codeBox(_ text: String) -> NSView {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        label.textColor = .labelColor
        label.isSelectable = true
        label.translatesAutoresizingMaskIntoConstraints = false
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.06).cgColor
        box.layer?.cornerRadius = 6
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(label)
        // Leave room for a trailing Copy button when it sits in a row.
        let w = inner - 80
        label.preferredMaxLayoutWidth = w - 20
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
            label.topAnchor.constraint(equalTo: box.topAnchor, constant: 7),
            label.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -7),
            box.widthAnchor.constraint(equalToConstant: w),
        ])
        return box
    }
}

/// One line of the checklist: ● icon · title — detail.
@MainActor
private final class ChecklistRow {
    enum Mark { case pending, ok, fail }

    let view = NSStackView()
    private let icon = NSImageView()
    private let detailLabel = NSTextField(labelWithString: "")

    init(title: String) {
        let t = NSTextField(labelWithString: title)
        t.font = .systemFont(ofSize: 12, weight: .medium)
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingMiddle
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 16).isActive = true
        view.orientation = .horizontal
        view.alignment = .centerY
        view.spacing = 8
        view.addArrangedSubview(icon)
        view.addArrangedSubview(t)
        view.addArrangedSubview(detailLabel)
        set(.pending, detail: "")
    }

    func set(_ mark: Mark, detail: String) {
        let (symbol, tint, description): (String, NSColor, String)
        switch mark {
        case .pending: (symbol, tint, description) = ("circle.dashed", .tertiaryLabelColor, "not checked yet")
        case .ok:      (symbol, tint, description) = ("checkmark.circle.fill", .systemGreen, "ok")
        case .fail:    (symbol, tint, description) = ("xmark.circle.fill", .systemRed, "missing")
        }
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
        icon.contentTintColor = tint
        detailLabel.stringValue = detail.isEmpty ? "" : "— \(detail)"
    }
}
