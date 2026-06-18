//
//  AboutWindow.swift
//  Lisa
//
//  Custom About window (replaces the standard about panel) so it can host the
//  update affordances the standard panel can't: a "Changelog" link to
//  meetlisa.ai and an in-place "Check for Updates" → "Download" flow.
//

import AppKit

final class AboutWindowController: NSWindowController {
    static let shared = AboutWindowController()

    private let statusLabel = NSTextField(labelWithString: "")
    private lazy var checkButton = NSButton(title: "Check for Updates", target: self, action: #selector(checkForUpdates))
    private lazy var downloadButton = NSButton(title: "Download", target: self, action: #selector(downloadUpdate))
    private var pendingDownloadURL: URL?

    private convenience init() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 360),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        win.titleVisibility = .hidden
        win.titlebarAppearsTransparent = true
        win.isMovableByWindowBackground = true
        win.isReleasedWhenClosed = false
        self.init(window: win)
        win.contentView = buildContent()
        win.center()
    }

    /// Show the About window in its resting state (manual check ready).
    func show() {
        statusLabel.stringValue = ""
        downloadButton.isHidden = true
        pendingDownloadURL = nil
        showWindow(nil)
        window?.center()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Show it already presenting a discovered update (from launch discovery).
    func show(update: UpdateInfo) {
        show()
        present(update)
    }

    // MARK: - layout

    private func buildContent() -> NSView {
        let icon = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 96).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 96).isActive = true

        let name = NSTextField(labelWithString: "Lisa")
        name.font = .systemFont(ofSize: 22, weight: .bold)
        name.alignment = .center

        let version = NSTextField(labelWithString: "Version \(Updater.shared.currentVersion)")
        version.font = .systemFont(ofSize: 12)
        version.textColor = .secondaryLabelColor
        version.alignment = .center

        let license = linkButton("MIT — github.com/oratis/LISA",
                                 url: URL(string: "https://github.com/oratis/LISA")!)

        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .center
        statusLabel.maximumNumberOfLines = 3
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.preferredMaxLayoutWidth = 320

        let changelog = NSButton(title: "Changelog", target: self, action: #selector(openChangelog))
        changelog.bezelStyle = .rounded
        checkButton.bezelStyle = .rounded
        downloadButton.bezelStyle = .rounded
        downloadButton.isHidden = true

        let buttonRow = NSStackView(views: [changelog, checkButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 12

        let stack = NSStackView(views: [icon, name, version, license, statusLabel, downloadButton, buttonRow])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 8
        stack.setCustomSpacing(14, after: icon)
        stack.setCustomSpacing(16, after: license)
        stack.setCustomSpacing(14, after: statusLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),
        ])
        return container
    }

    /// A borderless button styled as a hyperlink (reliable + accessible vs. a
    /// gesture-recognized label).
    private func linkButton(_ text: String, url: URL) -> NSButton {
        let b = NSButton(title: text, target: self, action: #selector(openLink(_:)))
        b.isBordered = false
        b.bezelStyle = .inline
        b.contentTintColor = .linkColor
        b.attributedTitle = NSAttributedString(string: text, attributes: [
            .foregroundColor: NSColor.linkColor,
            .font: NSFont.systemFont(ofSize: 11),
        ])
        b.toolTip = url.absoluteString
        linkURLs[ObjectIdentifier(b)] = url
        return b
    }
    private var linkURLs: [ObjectIdentifier: URL] = [:]

    // MARK: - actions

    @objc private func openLink(_ sender: NSButton) {
        if let u = linkURLs[ObjectIdentifier(sender)] { NSWorkspace.shared.open(u) }
    }

    @objc private func openChangelog() {
        NSWorkspace.shared.open(Updater.changelogURL)
    }

    @objc private func downloadUpdate() {
        if let u = pendingDownloadURL { NSWorkspace.shared.open(u) }
    }

    @objc func checkForUpdates() {
        checkButton.isEnabled = false
        downloadButton.isHidden = true
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = "Checking for updates…"
        Updater.shared.check { [weak self] result in
            guard let self = self else { return }
            self.checkButton.isEnabled = true
            switch result {
            case .upToDate(let current):
                self.statusLabel.textColor = .secondaryLabelColor
                self.statusLabel.stringValue = "You're on the latest version (\(current))."
            case .available(let info):
                self.present(info)
            case .failed(let why):
                self.statusLabel.textColor = .secondaryLabelColor
                self.statusLabel.stringValue = "Update check failed: \(why)"
            }
        }
    }

    private func present(_ info: UpdateInfo) {
        statusLabel.textColor = .controlAccentColor
        statusLabel.stringValue = "Update available: \(info.tag)  (you have \(Updater.shared.currentVersion))"
        pendingDownloadURL = info.downloadURL
        downloadButton.title = "Download \(info.tag)"
        downloadButton.isHidden = false
    }
}
