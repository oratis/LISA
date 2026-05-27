//
//  NotchDetector.swift
//  LisaIsland — Phase 2.2 of MAC_ISLAND_PLAN.md
//
//  Computes where to anchor the island pill on a given NSScreen so that on
//  notched Macs (MBP 14"/16" 2021+, MBA 2022+) the pill appears to "extend"
//  the notch downward, and on non-notched Macs it sits flush with the top
//  of the screen.
//
//  Key macOS 12+ NSScreen APIs:
//    - safeAreaInsets.top    — height of the menu bar region the notch
//                              cuts into; 0 on Macs without notch.
//    - auxiliaryTopLeftArea  — clickable menu bar to the left of the notch;
//                              nil on Macs without notch.
//    - auxiliaryTopRightArea — clickable menu bar to the right of the notch.
//
//  The notch itself occupies the gap between left and right auxiliary
//  areas, centered at screen.frame.midX.
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
    /// the top of the window sits at the very top edge of the screen —
    /// overlapping the menu bar on notched Macs, flush with it on others.
    static func anchor(for size: CGSize, on screen: NSScreen) -> NotchAnchor {
        let frame = screen.frame  // includes menu bar area

        // Horizontal center: always at screen midX. On notched Macs the
        // notch itself is centered at midX, so this aligns the pill with
        // the notch.
        let x = frame.midX - size.width / 2

        // Vertical: pill's TOP edge at the top of the physical screen.
        // (AppKit's origin is bottom-left of the window, so we subtract
        // the window's height from the top of the screen.)
        let y = frame.maxY - size.height

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
                // Notch width = gap between auxiliary areas
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
