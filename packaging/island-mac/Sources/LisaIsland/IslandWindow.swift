//
//  IslandWindow.swift
//  LisaIsland — Phase 2.1
//
//  Borderless, transparent, status-bar-level NSPanel that hosts the
//  WKWebView. NSPanel (rather than NSWindow) because we need
//  `nonactivatingPanel` style so clicking the pill doesn't deactivate
//  whatever app the user was in.
//
//  Placement here is "top-center of main screen". Notch-aware anchoring
//  on MBP 14/16 lives in Phase 2.2 (NotchDetector).
//
//  Phase 2.4 (ScreenContextWatcher) will hide the window when a
//  fullscreen app is active or the screen is being captured.
//

import AppKit

final class IslandWindow: NSPanel {
    // Default pill footprint — chosen to comfortably fit the Phase 1 web
    // widget's pill + expanded panel (~308pt wide, up to ~240pt tall).
    private static let defaultSize = CGSize(width: 330, height: 260)

    // How far below the top of visibleFrame the window sits.
    // visibleFrame already excludes the menu bar, so 0 = flush with menu bar.
    private static let topGap: CGFloat = 0

    init() {
        let frame = NSRect(origin: .zero, size: Self.defaultSize)
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        configureWindow()
        positionAtTopCenter()
        mountWebView()

        // Reposition on screen geometry changes (lid open/close, plugging
        // in an external display, resolution change).
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreenChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Window config

    private func configureWindow() {
        // Top z-order: above ordinary windows, below the real menu bar.
        level = .statusBar
        // Persist across spaces, ignore ⌘` cycling, behave nicely with
        // fullscreen apps.
        collectionBehavior = [
            .canJoinAllSpaces,
            .stationary,
            .ignoresCycle,
            .fullScreenAuxiliary,
        ]

        // Transparent backing so the web widget's rounded pill can show
        // through the borderless rect.
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false

        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = false
        // The pill responds to clicks; clicks outside the pill (e.g. on the
        // transparent surrounding area) should pass through to the app below.
        // CSS `pointer-events: none` on body + `auto` on the pill itself
        // handles that purely in the webview — the window itself stays
        // mouse-active so clicks on the pill register.
        ignoresMouseEvents = false

        // Suppress the panel's natural shadow / vibrancy.
        isFloatingPanel = true
        hidesOnDeactivate = false
    }

    // NSPanel becomes key by default when clicked. We never want focus —
    // the user is browsing / coding / whatever, the island is a passive
    // observer. Overriding canBecomeKey returning false stops focus theft.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    // MARK: - Positioning

    private func positionAtTopCenter() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = frame.size
        let origin = NSPoint(
            x: visible.midX - size.width / 2,
            y: visible.maxY - size.height - Self.topGap
        )
        setFrameOrigin(origin)
    }

    @objc private func handleScreenChange() {
        positionAtTopCenter()
    }

    // MARK: - WebView mount

    private func mountWebView() {
        let content = IslandContent()
        contentView = content.view
    }
}
