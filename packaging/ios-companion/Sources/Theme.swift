import SwiftUI

/// Agent-console palette — mirrors the web shell tokens (src/web/lisa-css.ts):
/// cyan accent, gold Lisa identity, green "proactive / live", dark card UI.
/// Defined once so views reference `Theme.*` instead of ad-hoc semantic colors.
enum Theme {
    // Surfaces
    static let bgDeep = Color(hex: 0x0A0E22)   // app background
    static let panel  = Color(hex: 0x0F1430)   // tab/nav bars, grouped lists
    static let card   = Color(hex: 0x161C3C)   // rows, cards, banners
    static let border = Color.white.opacity(0.08)

    // Text
    static let text      = Color(hex: 0xE8EAFF)
    static let secondary = Color(hex: 0x9AA3C8)
    static let tertiary  = Color(hex: 0x6B7299)

    // Identity / accents
    static let accent = Color(hex: 0x6AD4FF)   // cyan — nav / active / links
    static let gold   = Color(hex: 0xFFD066)   // Lisa identity
    static let green  = Color(hex: 0x3DDC97)   // proactive / live / done

    // Status pips — defined in Shared/GlanceColors so the widget extension (which
    // can't see Theme) renders identical status colors (review I1/B23).
    static let working = GlanceColors.working
    static let waiting = GlanceColors.waiting
    static let danger  = GlanceColors.error
    static let done    = GlanceColors.done
    static let idle    = GlanceColors.idle

    static let cardRadius: CGFloat = 12
    static let hairline: CGFloat = 0.5
}

extension Color {
    /// 0xRRGGBB initializer so tokens read as the hex in the design spec.
    init(hex: UInt32) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue:  Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}

// ── reusable console components ──────────────────────────────────────

/// Rounded console card: card fill + hairline border + padding.
struct ConsoleCard: ViewModifier {
    var padding: CGFloat = 14
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius).strokeBorder(Theme.border, lineWidth: Theme.hairline))
    }
}

extension View {
    func consoleCard(padding: CGFloat = 14) -> some View { modifier(ConsoleCard(padding: padding)) }

    /// Dark console canvas for a List / Form / ScrollView screen — clears the
    /// default grouped background and drops the deep app background behind it.
    func consoleBackground() -> some View {
        self.scrollContentBackground(.hidden).background(Theme.bgDeep.ignoresSafeArea())
    }
}

/// Status pip — replaces the hand-rolled `Circle().fill(stateColor(...))` dots.
struct StatusDot: View {
    let color: Color
    var size: CGFloat = 10
    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
    }
}

/// Themed capsule pill — same call shape as the old `Pill` (text + color).
struct ThemePill: View {
    let text: String
    var color: Color = Theme.accent
    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(color.opacity(0.16), in: Capsule())
            .foregroundStyle(color)
            .overlay(Capsule().strokeBorder(color.opacity(0.3), lineWidth: Theme.hairline))
    }
}

/// One stat cell in the Dispatch stat strip (count above, label below).
struct StatCell: View {
    let value: Int
    let label: String
    var tint: Color = Theme.accent
    var body: some View {
        VStack(spacing: 2) {
            Text("\(value)").font(.title3.weight(.medium)).foregroundStyle(tint)
            Text(label).font(.caption2).foregroundStyle(Theme.tertiary)
        }
        .frame(maxWidth: .infinity)
        .consoleCard(padding: 10)
    }
}
