//
//  IslandWindow.swift
//  LisaIsland — Phase 2.1 + 2.2
//
//  Borderless, transparent NSPanel that hosts the WKWebView. Sits at the
//  top edge of the screen, drawing OVER the menu bar at .popUpMenu level —
//  on notched Macs it visually extends the notch downward; on non-notched
//  Macs it sits flush with the top edge like a Dynamic Island clone.
//
//  Window sizing is dynamic: starts collapsed (pill-only ~50pt tall) so
//  it doesn't block menu bar clicks. Grows to expanded size when the web
//  widget tells us (via postMessage) the user hovered/clicked the pill.
//
//  NSPanel (rather than NSWindow) because we need `nonactivatingPanel`
//  style so clicking the pill doesn't deactivate the foreground app.
//

import AppKit

final class IslandWindow: NSPanel {
    // Collapsed: just the pill (avatar + "Lisa" + status dot)
    // Expanded: pill + ~250pt panel below for desire / idle message
    private static let collapsedSize = CGSize(width: 160, height: 50)
    private static let expandedSize  = CGSize(width: 330, height: 300)

    private(set) var isExpanded = false
    private var notchAnchor: NotchAnchor?

    init() {
        let initialFrame = NSRect(origin: .zero, size: Self.collapsedSize)
        super.init(
            contentRect: initialFrame,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        configureWindow()
        positionAtTopAnchor(animated: false)
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
        // ABOVE the menu bar — Dynamic-Island-style apps draw over it so
        // the pill can appear to extend the notch. Lower levels
        // (.statusBar = 25, .mainMenu = 24) sit at the menu bar and on
        // notched Macs would be eclipsed by the system notch.
        level = .popUpMenu

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
        ignoresMouseEvents = false

        // Suppress the panel's natural shadow / vibrancy.
        isFloatingPanel = true
        hidesOnDeactivate = false

        // Smooth resize animation when toggling expanded.
        animationBehavior = .utilityWindow
    }

    // NSPanel becomes key by default when clicked. We never want focus —
    // the user is browsing / coding / whatever, the island is a passive
    // observer.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    // AppKit's default `constrainFrameRect(_:to:)` snaps the window into
    // `visibleFrame` — i.e., below the menu bar. That's the WHOLE problem
    // we're trying to defeat: Dynamic-Island-style placement means the
    // pill sits AT the menu bar / over the notch. Returning the rect
    // unchanged lets us put the window wherever we want above the
    // visible area.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        return frameRect
    }

    // MARK: - Positioning

    private func positionAtTopAnchor(animated: Bool) {
        guard let screen = NSScreen.main else { return }
        let size = isExpanded ? Self.expandedSize : Self.collapsedSize
        let anchor = NotchDetector.anchor(for: size, on: screen)
        notchAnchor = anchor
        let target = NSRect(origin: anchor.origin, size: size)
        setFrame(target, display: true, animate: animated)
    }

    @objc private func handleScreenChange() {
        positionAtTopAnchor(animated: false)
    }

    // MARK: - Expand / collapse

    /// Called by IslandContent when the web widget reports a hover/click
    /// expand or a mouse-leave collapse. We resize the window so the
    /// expand panel rendered in the WebView isn't clipped.
    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        positionAtTopAnchor(animated: true)
    }

    // MARK: - WebView mount

    private func mountWebView() {
        let content = IslandContent(window: self)
        contentView = content.view
    }
}
