//
//  NotchDetector.swift
//  LisaIsland — Phase 2.2 of MAC_ISLAND_PLAN.md
//
//  Computes where to anchor the island pill on a given NSScreen.
//
//  IMPORTANT: on notched Macs (MBP 14"/16" 2021+, MBA 2022+) the physical
//  notch is opaque hardware — the camera/sensor cluster — and anything we
//  draw underneath it is invisible. So the pill's top edge anchors to the
//  BOTTOM of the safe area (just below the notch / menu bar), not to the
//  physical top of the screen. That way the avatar is always visible.
//
//  Horizontal: centered at screen midX, which on notched Macs aligns with
//  the notch center so the pill visually "hangs from" the notch.
//
//  Key macOS 12+ NSScreen APIs:
//    - safeAreaInsets.top    — height of the menu bar region the notch
//                              cuts into; 0 on Macs without notch.
//    - auxiliaryTopLeftArea  — clickable menu bar to the left of the notch;
//                              nil on Macs without notch.
//    - auxiliaryTopRightArea — clickable menu bar to the right of the notch.
//

import AppKit

struct NotchAnchor {
    /// Origin (bottom-left in AppKit coordinates) for the window frame.
    let origin: NSPoint
    /// Whether this screen has a notch we anchored to.
    let hasNotch: Bool
    /// Width of the physical notch (0 if not notched).
    let notchWidth: CGFloat
}

enum NotchDetector {

    /// Decide where to place a window of `size` on `screen` so the pill at
    /// the top of the window sits just below the menu bar (and below the
    /// notch on notched Macs), horizontally centered.
    static func anchor(for size: CGSize, on screen: NSScreen) -> NotchAnchor {
        // visibleFrame already excludes both the menu bar and the notch
        // region — so its top edge is exactly where we want the pill's
        // top edge to be. The pill itself sits at the top of the window
        // (CSS aligns to flex-start), so window.origin.y must place the
        // window's TOP edge at visibleFrame.maxY.
        let visible = screen.visibleFrame

        let x = visible.midX - size.width / 2
        let y = visible.maxY - size.height

        let (hasNotch, notchWidth) = detectNotch(on: screen)

        return NotchAnchor(
            origin: NSPoint(x: x, y: y),
            hasNotch: hasNotch,
            notchWidth: notchWidth
        )
    }

    /// Returns whether `screen` has a notch and, if so, its width in pts.
    static func detectNotch(on screen: NSScreen) -> (hasNotch: Bool, width: CGFloat) {
        if #available(macOS 12.0, *) {
            // safeAreaInsets.top is non-zero on notched Macs.
            if screen.safeAreaInsets.top > 0 {
                let leftRight = screen.auxiliaryTopRightArea?.minX
                    ?? screen.frame.midX
                let rightLeft = screen.auxiliaryTopLeftArea?.maxX
                    ?? screen.frame.midX
                let width = max(0, leftRight - rightLeft)
                return (true, width)
            }
        }
        return (false, 0)
    }
}
