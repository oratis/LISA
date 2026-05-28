//
//  MainWindow.swift
//  Lisa
//
//  Standard Mac window hosting the chat WKWebView. Remembers position +
//  size across launches via NSWindow's frameAutosaveName.
//

import AppKit

final class MainWindow: NSWindow {
    private static let defaultSize = CGSize(width: 1200, height: 800)
    private static let minSize     = CGSize(width: 600, height: 500)

    private let content = WebContent()

    convenience init() {
        let frame = NSRect(origin: .zero, size: Self.defaultSize)
        self.init(
            contentRect: frame,
            styleMask: [
                .titled,
                .closable,
                .miniaturizable,
                .resizable,
                .fullSizeContentView,
            ],
            backing: .buffered,
            defer: false
        )

        title = "Lisa"
        minSize = Self.minSize
        // Title bar transparent so the chat's pixel-art background can extend
        // edge-to-edge underneath the traffic lights.
        titlebarAppearsTransparent = true
        toolbarStyle = .unified
        isReleasedWhenClosed = false   // AppDelegate keeps a strong reference

        // Persist last frame across launches. The name is namespaced so we
        // don't clash with anything else the user has in defaults.
        setFrameAutosaveName("ai.meetlisa.app.MainWindow")

        // Center on first launch (autosave restores subsequent launches).
        if !setFrameUsingName("ai.meetlisa.app.MainWindow") {
            center()
        }

        contentViewController = content
    }

    func reload() {
        content.reload()
    }
}
