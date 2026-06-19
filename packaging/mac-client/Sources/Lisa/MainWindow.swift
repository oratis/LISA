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
        // Hide the NATIVE title text: the hosted page draws its own branded
        // ".titlebar" ("Lisa") in that strip, so showing the native title too
        // rendered a duplicate "Lisa Lisa" in the title bar.
        titleVisibility = .hidden
        toolbarStyle = .unified
        isReleasedWhenClosed = false   // AppDelegate keeps a strong reference

        // Persist last frame across launches. The autosave key is
        // versioned — bumping it forces every user (including ones who
        // had a small window on the old pixel-art shell) to land back on
        // the 1200×800 default once when they pick up the redesign.
        // After this single reset, subsequent resizes are remembered.
        let autosaveKey = "ai.meetlisa.app.MainWindow.v2-redesign"
        setFrameAutosaveName(autosaveKey)

        if !setFrameUsingName(autosaveKey) {
            // Fresh user / first run after the namespace bump: ensure
            // we're really at 1200×800 (init's contentRect can be
            // overridden by AppKit on some HiDPI setups), then center.
            setContentSize(Self.defaultSize)
            center()
        }

        contentViewController = content
    }

    func reload() {
        content.reload()
    }

    /// Fire the screenshot→composer flow in the hosted page; `onAttached`
    /// reports whether a shot was actually captured (vs cancelled).
    func triggerCapture(onAttached: @escaping (Bool) -> Void) {
        content.triggerCapture(onAttached: onAttached)
    }

    /// Pre-fill the chat composer (never auto-sends) — used by the
    /// screen-advisor suggestion card via the island bridge.
    func prefillComposer(_ text: String) {
        content.prefillComposer(text)
    }
}
