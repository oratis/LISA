import SwiftUI
import UIKit

/// Canonical agent-status colors, shared by the app (via `Theme`) and the widget
/// extension, so a given state looks identical in the roster, the Live Activity,
/// and the home Widget. Lives in `Shared/` because the widget target doesn't
/// compile `Theme.swift` — which is why the widget/activity previously hardcoded
/// system `.blue/.yellow/.red/...` that visibly mismatched the app (review I1/B23).
enum GlanceColors {
    static let working = adaptive(dark: 0x7EA6FF, light: 0x315EAF)
    static let waiting = adaptive(dark: 0xFFB84D, light: 0x8B5A00)
    static let error   = adaptive(dark: 0xFF7389, light: 0xBE2945)
    static let done    = adaptive(dark: 0x3DDC97, light: 0x147653)
    static let idle    = adaptive(dark: 0x969FBE, light: 0x5F6878)

    /// State → a word, so a status pip is never colour-only (review D1). Lives
    /// beside the palette because the widget and Live Activity targets can't see
    /// the app's copy and must read the same phrase VoiceOver hears in the roster.
    static func phrase(_ state: String) -> String {
        switch state {
        case "working": return "working"
        case "waiting": return "waiting on you"
        case "error":   return "errored"
        case "done":    return "done"
        default:        return "idle"
        }
    }

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

    private static func adaptive(dark: UInt32, light: UInt32) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .light ? light : dark
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
                           green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
    }
}
