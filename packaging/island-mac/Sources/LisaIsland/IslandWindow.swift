//
//  IslandWindow.swift
//  LisaIsland — Phase 2.1 + 2.2
//
//  Borderless, transparent NSPanel that hosts the WKWebView. Sits just
//  below the menu bar / notch by default (so the avatar isn't eclipsed
//  by the physical notch hardware), horizontally centered. User can hold
//  ⌥ (Option) and drag to reposition; the chosen position is persisted
//  to UserDefaults and restored on next launch.
//
//  Window sizing is dynamic: starts collapsed (~50pt tall, pill-only) so
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

    // UserDefaults keys for the drag-saved position.
    private enum DefaultsKey {
        static let hasUserOrigin = "ai.meetlisa.island.hasUserOrigin"
        static let userOriginX   = "ai.meetlisa.island.userOriginX"
        static let userOriginY   = "ai.meetlisa.island.userOriginY"
    }

    private(set) var isExpanded = false

    init() {
        let initialFrame = NSRect(origin: .zero, size: Self.collapsedSize)
        super.init(
            contentRect: initialFrame,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        configureWindow()
        repositionForCurrentState(animated: false)
        mountWebView()

        // Reposition on screen geometry changes (lid open/close, plugging
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
        // Above the menu bar — Dynamic-Island-style placement means the
        // pill draws on top of menubar items that happen to be under it.
        // .mainMenu + 3 matches Boring Notch / other notch-extender apps;
        // .popUpMenu (101) is too aggressive and steals focus from
        // Spotlight / Notification Center.
        level = NSWindow.Level(Int(NSWindow.Level.mainMenu.rawValue) + 3)

        collectionBehavior = [
            .canJoinAllSpaces,
            .stationary,
            .ignoresCycle,
            .fullScreenAuxiliary,
        ]

        backgroundColor = .clear
        isOpaque = false
        hasShadow = false

        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        // Default drag is off; we handle ⌥+drag manually in sendEvent.
        isMovableByWindowBackground = false
        ignoresMouseEvents = false

        isFloatingPanel = true
        hidesOnDeactivate = false

        animationBehavior = .utilityWindow
    }

    // NSPanel becomes key by default when clicked. We never want focus —
    // the user is browsing / coding / whatever; the island is passive.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    // AppKit's default constrainFrameRect snaps the window into
    // visibleFrame — which is mostly fine now that we anchor BELOW the
    // notch, but we keep the override so a user-dragged position can
    // legitimately overlap the menu bar (e.g. corner-pinning) without
    // the system pulling it back.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        return frameRect
    }

    // MARK: - Position resolution

    /// Default anchor (just below the notch / menu bar), no user override.
    private func defaultOrigin(for size: CGSize, on screen: NSScreen) -> NSPoint {
        return NotchDetector.anchor(for: size, on: screen).origin
    }

    /// User-saved origin, or nil if the user hasn't dragged.
    private func savedOrigin() -> NSPoint? {
        let d = UserDefaults.standard
        guard d.bool(forKey: DefaultsKey.hasUserOrigin) else { return nil }
        let x = d.double(forKey: DefaultsKey.userOriginX)
        let y = d.double(forKey: DefaultsKey.userOriginY)
        return NSPoint(x: x, y: y)
    }

    private func saveOrigin(_ origin: NSPoint) {
        let d = UserDefaults.standard
        d.set(true, forKey: DefaultsKey.hasUserOrigin)
        d.set(Double(origin.x), forKey: DefaultsKey.userOriginX)
        d.set(Double(origin.y), forKey: DefaultsKey.userOriginY)
    }

    /// Forget the dragged position; revert to default anchor.
    func resetSavedOrigin() {
        let d = UserDefaults.standard
        d.removeObject(forKey: DefaultsKey.hasUserOrigin)
        d.removeObject(forKey: DefaultsKey.userOriginX)
        d.removeObject(forKey: DefaultsKey.userOriginY)
        repositionForCurrentState(animated: true)
    }

    /// Clamp a candidate origin to keep at least part of the window
    /// on-screen (so a user can't accidentally drag it into the void).
    private func clampToScreen(_ origin: NSPoint, size: CGSize, on screen: NSScreen) -> NSPoint {
        let bounds = screen.frame
        // Keep at least 40pt of the window visible on each axis.
        let margin: CGFloat = 40
        let minX = bounds.minX - size.width + margin
        let maxX = bounds.maxX - margin
        let minY = bounds.minY - size.height + margin
        let maxY = bounds.maxY - margin
        return NSPoint(
            x: min(max(origin.x, minX), maxX),
            y: min(max(origin.y, minY), maxY)
        )
    }

    /// Compute where the window should sit for its current state
    /// (collapsed vs expanded) and the saved-vs-default anchor choice.
    /// Expansion grows downward from the pill's top edge so the pill
    /// doesn't visually jump.
    private func currentOrigin(for size: CGSize, on screen: NSScreen) -> NSPoint {
        let collapsedSize = Self.collapsedSize
        // The pill's top edge is what stays anchored. Compute the pill
        // top edge first (from collapsed-state origin), then derive the
        // origin for the requested `size`.
        let collapsedOrigin: NSPoint = {
            if let saved = savedOrigin() {
                return clampToScreen(saved, size: collapsedSize, on: screen)
            }
            return defaultOrigin(for: collapsedSize, on: screen)
        }()
        let pillTopY = collapsedOrigin.y + collapsedSize.height
        let pillCenterX = collapsedOrigin.x + collapsedSize.width / 2

        return NSPoint(
            x: pillCenterX - size.width / 2,
            y: pillTopY - size.height
        )
    }

    private func repositionForCurrentState(animated: Bool) {
        guard let screen = NSScreen.main else { return }
        let size = isExpanded ? Self.expandedSize : Self.collapsedSize
        let origin = currentOrigin(for: size, on: screen)
        setFrame(NSRect(origin: origin, size: size), display: true, animate: animated)
    }

    @objc private func handleScreenChange() {
        repositionForCurrentState(animated: false)
    }

    // MARK: - Expand / collapse

    /// Called by IslandContent when the web widget reports a hover/click
    /// expand or a mouse-leave collapse.
    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        repositionForCurrentState(animated: true)
    }

    // MARK: - WebView mount

    private func mountWebView() {
        let content = IslandContent(window: self)
        contentView = content.view
    }

    // MARK: - ⌥+drag to reposition

    /// `sendEvent` runs BEFORE the contentView (WKWebView) gets a chance
    /// to handle the event. If the user holds ⌥ on mouse-down, we steal
    /// the event and start a window-drag tracking loop instead of letting
    /// the page see it.
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown,
           event.modifierFlags.contains(.option) {
            // Begin native AppKit drag. Returns when the user releases
            // the mouse. We then save the new origin.
            self.performDrag(with: event)
            saveOrigin(frame.origin)
            return
        }
        super.sendEvent(event)
    }
}
