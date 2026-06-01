//
//  IslandWindow.swift
//  LisaIsland — Phase 2.1 + 2.2
//
//  Borderless, transparent NSPanel that hosts the WKWebView.
//
//  Architecture (after the post-flicker rework):
//
//   • Window is a CONSTANT 330×300. We never resize it on expand /
//     collapse — that was the source of the click-flicker.
//   • The pill renders in the TOP 50pt of the window (CSS aligns it to
//     flex-start). The bottom 250pt is for the expand panel, hidden via
//     CSS when collapsed.
//   • Click-through outside the pill: a polling timer checks the cursor
//     against the "hot rect" (just the pill when collapsed, the whole
//     window when expanded) and toggles `ignoresMouseEvents`. So the
//     250pt transparent area below the pill doesn't steal menu-bar or
//     content clicks when the user isn't actively engaging with Lisa.
//   • Drag is Swift-side, not JS: `sendEvent(_:)` intercepts
//     `.leftMouseDown` and runs a synchronous nextEvent loop tracking
//     mouseDragged / mouseUp. Movement > 4px ⇒ drag (setFrameOrigin
//     each tick, no IPC roundtrip). No movement ⇒ click (forward
//     `pill.click()` into the WKWebView).
//   • The pill's screen position is persisted as the window origin
//     (since the window is a fixed size, the origin IS the anchor).
//

import AppKit
import WebKit

final class IslandWindow: NSPanel {
    // Fixed window footprint. Pill renders in the top 50pt; expand
    // panel renders below (visible only via CSS). Sized to comfortably
    // fit 5 Claude session rows + desire text + actions without
    // clipping — the architecture comment above explains why the
    // window stays constant rather than resizing on expand/collapse.
    static let windowSize = CGSize(width: 360, height: 440)
    static let pillHeight: CGFloat = 50

    // 4pt deadband: cursor must move at least this much before we treat
    // the mousedown as a drag rather than a click.
    private static let dragThreshold: CGFloat = 4

    // UserDefaults keys.
    private enum DefaultsKey {
        static let hasUserOrigin = "ai.meetlisa.island.hasUserOrigin"
        static let userOriginX   = "ai.meetlisa.island.userOriginX"
        static let userOriginY   = "ai.meetlisa.island.userOriginY"
    }

    /// Tracked from CSS expand state via postMessage from island.ts.
    /// When expanded, the hover-hot-rect is the entire window; when
    /// collapsed, it's just the pill.
    private var expandedHot = false

    private var hoverTimer: Timer?

    init() {
        let frame = NSRect(origin: .zero, size: Self.windowSize)
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        configureWindow()
        repositionWindow()
        mountWebView()
        startHoverPolling()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreenChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    deinit {
        hoverTimer?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Config

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
        // Start in pass-through; hoverPoll will flip this on/off based
        // on cursor position vs hot-rect.
        ignoresMouseEvents = true
        isFloatingPanel = true
        hidesOnDeactivate = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        return frameRect
    }

    // MARK: - Position

    private func savedOrigin() -> NSPoint? {
        let d = UserDefaults.standard
        guard d.bool(forKey: DefaultsKey.hasUserOrigin) else { return nil }
        return NSPoint(
            x: d.double(forKey: DefaultsKey.userOriginX),
            y: d.double(forKey: DefaultsKey.userOriginY)
        )
    }

    private func saveCurrentOrigin() {
        let d = UserDefaults.standard
        d.set(true, forKey: DefaultsKey.hasUserOrigin)
        d.set(Double(frame.origin.x), forKey: DefaultsKey.userOriginX)
        d.set(Double(frame.origin.y), forKey: DefaultsKey.userOriginY)
    }

    func resetSavedOrigin() {
        let d = UserDefaults.standard
        d.removeObject(forKey: DefaultsKey.hasUserOrigin)
        d.removeObject(forKey: DefaultsKey.userOriginX)
        d.removeObject(forKey: DefaultsKey.userOriginY)
        repositionWindow()
    }

    /// Default: pill's top edge sits at visibleFrame.maxY (just below
    /// menu bar / notch), horizontally centered on the screen midX.
    /// Since the pill is in the top 50pt of a 300pt-tall window, the
    /// window's TOP edge equals visibleFrame.maxY, so origin.y =
    /// visibleFrame.maxY - windowHeight.
    private func defaultOrigin(on screen: NSScreen) -> NSPoint {
        let visible = screen.visibleFrame
        return NSPoint(
            x: visible.midX - Self.windowSize.width / 2,
            y: visible.maxY - Self.windowSize.height
        )
    }

    private func clampedOrigin(_ origin: NSPoint, on screen: NSScreen) -> NSPoint {
        let bounds = screen.frame
        let pillVisibleMargin: CGFloat = 40
        // Keep at least 40pt of the PILL on screen, so the user can't
        // lose it. The pill is in the top 50pt of the window.
        let minX = bounds.minX - Self.windowSize.width + pillVisibleMargin
        let maxX = bounds.maxX - pillVisibleMargin
        // Lower bound: pill top must still be inside the screen.
        // Pill top y in AppKit coords = origin.y + windowHeight.
        // Need pill top > bounds.minY + pillVisibleMargin → origin.y >
        // bounds.minY + pillVisibleMargin - windowHeight.
        let minY = bounds.minY + pillVisibleMargin - Self.windowSize.height
        // Upper bound: window can sit up to screen-top.
        let maxY = bounds.maxY - Self.windowSize.height + Self.pillHeight - pillVisibleMargin
        return NSPoint(
            x: min(max(origin.x, minX), maxX),
            y: min(max(origin.y, minY), maxY)
        )
    }

    private func repositionWindow() {
        guard let screen = NSScreen.main else { return }
        let origin: NSPoint
        if let saved = savedOrigin() {
            origin = clampedOrigin(saved, on: screen)
        } else {
            origin = defaultOrigin(on: screen)
        }
        setFrame(NSRect(origin: origin, size: Self.windowSize),
                 display: true,
                 animate: false)
    }

    @objc private func handleScreenChange() {
        repositionWindow()
    }

    // MARK: - Hot rect + click-through polling

    /// Called by IslandContent on receipt of an `expand` / `collapse`
    /// postMessage from the page. Updates which rect is "hot" for
    /// click-passthrough decisions.
    func setExpanded(_ expanded: Bool) {
        expandedHot = expanded
    }

    /// Pill rect in screen-space (top 50pt of the window).
    private var pillScreenRect: NSRect {
        let top = frame.origin.y + frame.height
        return NSRect(
            x: frame.origin.x,
            y: top - Self.pillHeight,
            width: frame.width,
            height: Self.pillHeight
        )
    }

    private func startHoverPolling() {
        // 50ms = 20Hz. Cheap. Adequate for "cursor over pill" detection.
        hoverTimer = Timer.scheduledTimer(
            withTimeInterval: 0.05,
            repeats: true
        ) { [weak self] _ in
            self?.updateClickPassthrough()
        }
    }

    private func updateClickPassthrough() {
        let mouse = NSEvent.mouseLocation
        // When expanded, the whole window is hot (so the user can
        // click buttons in the expand panel). When collapsed, only the
        // pill rectangle is hot.
        let hot: NSRect = expandedHot ? frame : pillScreenRect
        let inHot = NSPointInRect(mouse, hot)
        let shouldIgnore = !inHot
        if ignoresMouseEvents != shouldIgnore {
            ignoresMouseEvents = shouldIgnore
        }
    }

    // MARK: - Swift-side drag (mouseDown intercepted at sendEvent)

    override func sendEvent(_ event: NSEvent) {
        // Only intercept clicks that land on the pill rect. Clicks
        // elsewhere (expand panel: Open chat / Dismiss / Claude rows /
        // Open in Finder / Copy resume / notify CTA) need to reach the
        // WKWebView so their JS click handlers fire normally. Without
        // this hit-test every click was being rewritten into a
        // pill.click() — which just toggled the expand panel,
        // appearing to do nothing.
        if event.type == .leftMouseDown {
            let mouse = NSEvent.mouseLocation
            if NSPointInRect(mouse, pillScreenRect) {
                handleMouseDown(event)
                return
            }
        }
        super.sendEvent(event)
    }

    private func handleMouseDown(_ down: NSEvent) {
        let initialOrigin   = frame.origin
        let downScreen      = NSEvent.mouseLocation
        var moved           = false

        while true {
            // Pull the next mouse-drag-or-up event off the queue.
            // .eventTracking run loop mode keeps us in the active drag
            // tracking phase without interleaving non-mouse events.
            guard let evt = NSApplication.shared.nextEvent(
                matching: [.leftMouseDragged, .leftMouseUp],
                until: .distantFuture,
                inMode: .eventTracking,
                dequeue: true
            ) else { return }

            let now = NSEvent.mouseLocation
            let dx = now.x - downScreen.x
            let dy = now.y - downScreen.y

            switch evt.type {
            case .leftMouseDragged:
                if !moved && (abs(dx) > Self.dragThreshold || abs(dy) > Self.dragThreshold) {
                    moved = true
                }
                if moved {
                    setFrameOrigin(NSPoint(
                        x: initialOrigin.x + dx,
                        y: initialOrigin.y + dy
                    ))
                }
            case .leftMouseUp:
                if moved {
                    saveCurrentOrigin()
                } else {
                    // It was a click. Synthesize the pill click in JS so
                    // expand-toggle / button handlers run as normal.
                    forwardPillClick()
                }
                return
            default:
                break
            }
        }
    }

    private func forwardPillClick() {
        guard let wv = contentView as? WKWebView else {
            FileHandle.standardError.write(
                Data("[island] forwardPillClick: contentView not WKWebView\n".utf8)
            )
            return
        }
        FileHandle.standardError.write(Data("[island] forwarding click\n".utf8))
        wv.evaluateJavaScript("document.getElementById('pill')?.click();") { _, err in
            if let err = err {
                FileHandle.standardError.write(
                    Data("[island] evalJS error: \(err)\n".utf8)
                )
            }
        }
    }

    // MARK: - WebView mount

    private func mountWebView() {
        let content = IslandContent(window: self)
        contentView = content.view
    }
}
