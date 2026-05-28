//
//  IslandWindow.swift
//  LisaIsland — Phase 2.1 + 2.2
//
//  Borderless, transparent NSPanel that hosts the WKWebView. Sits just
//  below the menu bar / notch by default (so the avatar isn't eclipsed
//  by the physical notch hardware), horizontally centered. User can
//  click-and-drag anywhere on the pill to reposition. The chosen
//  position is persisted to UserDefaults and restored at next launch.
//
//  Window sizing is dynamic: starts collapsed (~50pt tall, pill-only)
//  and grows downward to expanded size when the web widget tells us
//  (via postMessage) the user clicked/hovered. The resize is INSTANT
//  (no animation) so the pill's screen position never visually drifts
//  during state changes; the in-page CSS fade animates the panel's
//  appearance instead.
//
//  Persisted anchor is normalized to the COLLAPSED-state origin —
//  regardless of which state the user dragged in, we recover the pill's
//  top edge and re-derive a fresh origin for any size. This kills the
//  "click → window jumps 250pt up" drift.
//

import AppKit

final class IslandWindow: NSPanel {
    // Collapsed: just the pill (avatar + "Lisa" + status dot)
    // Expanded: pill + ~250pt panel below for desire / idle message
    static let collapsedSize = CGSize(width: 160, height: 50)
    static let expandedSize  = CGSize(width: 330, height: 300)

    // UserDefaults keys for the drag-saved anchor.
    private enum DefaultsKey {
        static let hasUserOrigin = "ai.meetlisa.island.hasUserOrigin"
        // Anchor is stored as the COLLAPSED-state bottom-left origin,
        // so the same value reconstructs any size correctly.
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
        repositionForCurrentState()
        mountWebView()

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
        isMovableByWindowBackground = false
        ignoresMouseEvents = false
        isFloatingPanel = true
        hidesOnDeactivate = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        // Don't snap into visibleFrame — the user is allowed to drag
        // anywhere, including overlapping menu bar / corners.
        return frameRect
    }

    // MARK: - Anchor persistence (always collapsed-equivalent)

    private func savedCollapsedOrigin() -> NSPoint? {
        let d = UserDefaults.standard
        guard d.bool(forKey: DefaultsKey.hasUserOrigin) else { return nil }
        return NSPoint(
            x: d.double(forKey: DefaultsKey.userOriginX),
            y: d.double(forKey: DefaultsKey.userOriginY)
        )
    }

    private func saveCollapsedOrigin(_ origin: NSPoint) {
        let d = UserDefaults.standard
        d.set(true, forKey: DefaultsKey.hasUserOrigin)
        d.set(Double(origin.x), forKey: DefaultsKey.userOriginX)
        d.set(Double(origin.y), forKey: DefaultsKey.userOriginY)
    }

    /// Snapshot the pill's current screen position as a collapsed-state
    /// origin. Call this after a user drag completes so the next state
    /// transition (collapse ↔ expand) reconstructs from the same pill
    /// position rather than the window's current origin.
    func saveCurrentPositionAsAnchor() {
        // Pill's top edge = window's top edge (CSS aligns to flex-start)
        // Pill's center x = window's center x
        let pillTopY    = frame.maxY
        let pillCenterX = frame.midX
        let collapsedX  = pillCenterX - Self.collapsedSize.width / 2
        let collapsedY  = pillTopY    - Self.collapsedSize.height
        saveCollapsedOrigin(NSPoint(x: collapsedX, y: collapsedY))
    }

    func resetSavedOrigin() {
        let d = UserDefaults.standard
        d.removeObject(forKey: DefaultsKey.hasUserOrigin)
        d.removeObject(forKey: DefaultsKey.userOriginX)
        d.removeObject(forKey: DefaultsKey.userOriginY)
        repositionForCurrentState()
    }

    // MARK: - Position resolution

    private func defaultCollapsedOrigin(on screen: NSScreen) -> NSPoint {
        return NotchDetector.anchor(for: Self.collapsedSize, on: screen).origin
    }

    /// Compute the window origin for the given size given the current
    /// state. The pill's top edge stays at the same screen y whether
    /// collapsed or expanded; the expanded window simply extends
    /// downward.
    private func originForCurrentState(size: CGSize, on screen: NSScreen) -> NSPoint {
        let collapsedOrigin: NSPoint
        if let saved = savedCollapsedOrigin() {
            collapsedOrigin = clamp(saved, to: screen)
        } else {
            collapsedOrigin = defaultCollapsedOrigin(on: screen)
        }
        let pillTopY    = collapsedOrigin.y + Self.collapsedSize.height
        let pillCenterX = collapsedOrigin.x + Self.collapsedSize.width / 2
        return NSPoint(
            x: pillCenterX - size.width / 2,
            y: pillTopY    - size.height
        )
    }

    /// Allow positioning anywhere on screen but keep at least 40pt of
    /// the COLLAPSED pill on screen so it can't be lost.
    private func clamp(_ origin: NSPoint, to screen: NSScreen) -> NSPoint {
        let s = Self.collapsedSize
        let bounds = screen.frame
        let margin: CGFloat = 40
        return NSPoint(
            x: min(max(origin.x, bounds.minX - s.width + margin), bounds.maxX - margin),
            y: min(max(origin.y, bounds.minY - s.height + margin), bounds.maxY - margin)
        )
    }

    func repositionForCurrentState() {
        guard let screen = NSScreen.main else { return }
        let size = isExpanded ? Self.expandedSize : Self.collapsedSize
        let origin = originForCurrentState(size: size, on: screen)
        // No animation. The page's CSS fades in the expand panel; the
        // window itself swaps instantly so the pill never visually
        // drifts during expand/collapse.
        setFrame(NSRect(origin: origin, size: size), display: true, animate: false)
    }

    @objc private func handleScreenChange() {
        repositionForCurrentState()
    }

    // MARK: - Expand / collapse

    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        repositionForCurrentState()
    }

    // MARK: - Direct origin translation (driven by JS drag)

    /// Move the window by (dx, dy) in **screen-coordinate deltas** (y
    /// positive = down, matching browser screenY). Called once per
    /// pointermove from the JS drag tracker. We invert y to AppKit
    /// (bottom-left origin where y positive = up).
    func translateOriginByScreenDelta(dx: CGFloat, dy: CGFloat) {
        var newOrigin = frame.origin
        newOrigin.x += dx
        newOrigin.y -= dy   // screen y → AppKit y
        setFrameOrigin(newOrigin)
    }

    // MARK: - WebView mount

    private func mountWebView() {
        let content = IslandContent(window: self)
        contentView = content.view
    }
}
