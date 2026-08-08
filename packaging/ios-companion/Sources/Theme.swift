import SwiftUI

/// Agent-console palette — mirrors the web shell tokens (src/web/lisa-css.ts,
/// token table: docs/PLAN_UI_SESSION_SHELL_v1.0.md §2): each color carries a
/// dark ("Nebula") and light ("Calm") variant, resolved by the trait
/// environment — the appearance picker in Settings drives
/// `.preferredColorScheme` at the root, and every `Theme.*` follows.
enum Theme {
    // Surfaces
    static let bgDeep = Color(dark: 0x0A0E22, light: 0xF6F7F9)   // app background
    static let panel  = Color(dark: 0x0F1430, light: 0xFFFFFF)   // tab/nav bars, grouped lists
    static let card   = Color(dark: 0x161C3C, light: 0xFFFFFF)   // rows, cards, banners
    static let border = Color.primary.opacity(0.08)              // hairline (trait-aware)
    /// Sunken code/log wells (CodeBlock) — deep in Nebula, faint in Calm.
    static let sunken = Color(UIColor { t in
        t.userInterfaceStyle == .light
            ? UIColor.black.withAlphaComponent(0.05)
            : UIColor.black.withAlphaComponent(0.25)
    })

    // Text
    static let text      = Color(dark: 0xE8EAFF, light: 0x1B2430)
    static let secondary = Color(dark: 0x9AA3C8, light: 0x4D5666)
    static let tertiary  = Color(dark: 0x6B7299, light: 0x8A919F)

    // Identity / accents
    static let accent = Color(dark: 0x6AD4FF, light: 0x4F5BD5)   // cyan / calm indigo
    static let gold   = Color(dark: 0xFFD066, light: 0xD97706)   // Lisa identity
    static let green  = Color(dark: 0x3DDC97, light: 0x1F9D6B)   // proactive / live / done

    // Status pips — defined in Shared/GlanceColors so the widget extension (which
    // can't see Theme) renders identical status colors (review I1/B23).
    static let working = GlanceColors.working
    static let waiting = GlanceColors.waiting
    static let danger  = GlanceColors.error
    static let done    = GlanceColors.done
    static let idle    = GlanceColors.idle

    static let cardRadius: CGFloat = 12
    static let hairline: CGFloat = 0.5

    /// One spacing scale so padding/stack-spacing is consistent across screens
    /// (review I3 — values were ad-hoc 8/12/14/18/22/… everywhere).
    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 14
        static let l: CGFloat = 20
        static let xl: CGFloat = 28
    }
}

/// One code/log block — monospaced, selectable, scrollable in both axes (so long
/// lines don't clip), on a sunken card. Replaces the three different mono
/// treatments (PTY output / recap / memory) the review flagged (I4).
struct CodeBlock: View {
    let text: String
    var maxHeight: CGFloat? = nil
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(maxHeight: maxHeight)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: Theme.hairline))
    }
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

    /// Trait-aware token: one hex per appearance (Nebula dark / Calm light),
    /// resolved live by UIKit's trait environment.
    init(dark: UInt32, light: UInt32) {
        self.init(UIColor { traits in
            let hex = traits.userInterfaceStyle == .light ? light : dark
            return UIColor(
                red:   CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue:  CGFloat(hex & 0xFF) / 255,
                alpha: 1)
        })
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
