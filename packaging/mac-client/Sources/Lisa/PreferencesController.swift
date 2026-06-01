//
//  PreferencesController.swift
//  Lisa
//
//  The Settings window (⌘,). A small native panel for app-level toggles —
//  currently the Lisa Island switch. Lazily created, reused across opens.
//

import AppKit

final class PreferencesController: NSObject, NSWindowDelegate {
    static let shared = PreferencesController()
    private override init() { super.init() }

    private var window: NSWindow?
    private var islandCheckbox: NSButton?
    private var resetButton: NSButton?

    func show() {
        if window == nil { build() }
        syncControls()
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Build

    private func build() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 180),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        win.title = "Lisa Settings"
        win.isReleasedWhenClosed = false
        win.delegate = self

        let content = NSView(frame: win.contentLayoutRect)
        content.autoresizingMask = [.width, .height]

        // Section header
        let header = label("Lisa Island", size: 13, bold: true)
        header.frame = NSRect(x: 24, y: 130, width: 372, height: 20)
        content.addSubview(header)

        // The toggle
        let checkbox = NSButton(checkboxWithTitle: "Show Lisa Island (notch pill)",
                                target: self, action: #selector(toggleIsland(_:)))
        checkbox.frame = NSRect(x: 22, y: 100, width: 372, height: 22)
        content.addSubview(checkbox)
        islandCheckbox = checkbox

        // Sub-caption
        let caption = label("A small floating pill by the menu bar / notch that shows Lisa's mood and your agents' activity.",
                            size: 11, bold: false)
        caption.textColor = .secondaryLabelColor
        caption.frame = NSRect(x: 42, y: 60, width: 354, height: 34)
        (caption.cell as? NSTextFieldCell)?.wraps = true
        caption.lineBreakMode = .byWordWrapping
        content.addSubview(caption)

        // Reset position
        let reset = NSButton(title: "Reset Island Position",
                             target: self, action: #selector(resetPosition(_:)))
        reset.bezelStyle = .rounded
        reset.frame = NSRect(x: 22, y: 18, width: 200, height: 28)
        content.addSubview(reset)
        resetButton = reset

        win.contentView = content
        window = win
    }

    private func label(_ text: String, size: CGFloat, bold: Bool) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        return l
    }

    // MARK: - State

    private func syncControls() {
        let on = IslandController.shared.isEnabled
        islandCheckbox?.state = on ? .on : .off
        resetButton?.isEnabled = on
    }

    // MARK: - Actions

    @objc private func toggleIsland(_ sender: NSButton) {
        IslandController.shared.setEnabled(sender.state == .on)
        syncControls()
    }

    @objc private func resetPosition(_ sender: Any?) {
        IslandController.shared.resetPosition()
    }
}
