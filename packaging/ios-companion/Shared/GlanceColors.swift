import SwiftUI

/// Canonical agent-status colors, shared by the app (via `Theme`) and the widget
/// extension, so a given state looks identical in the roster, the Live Activity,
/// and the home Widget. Lives in `Shared/` because the widget target doesn't
/// compile `Theme.swift` — which is why the widget/activity previously hardcoded
/// system `.blue/.yellow/.red/...` that visibly mismatched the app (review I1/B23).
enum GlanceColors {
    static let working = rgb(0x5B9DFF)
    static let waiting = rgb(0xFFB84D)
    static let error   = rgb(0xFF5D73)
    static let done    = rgb(0x3DDC97)
    static let idle    = rgb(0x6B7299)

    /// State → color, using the same buckets as the roster.
    static func forState(_ state: String) -> Color {
        switch state {
        case "working": return working
        case "waiting": return waiting
        case "error":   return error
        case "done":    return done
        default:        return idle
        }
    }

    private static func rgb(_ hex: UInt32) -> Color {
        Color(.sRGB,
              red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255,
              opacity: 1)
    }
}
