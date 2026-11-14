import SwiftUI

/// Paper, ink and botanical tones shared by the room, reading views and controls.
enum Theme {
    static let bgDeep = Color(dark: 0x121B19, light: 0xF8F6EF)
    static let panel  = Color(dark: 0x182320, light: 0xFCFAF4)
    static let card   = Color(dark: 0x1E2926, light: 0xFFFEFA)
    static let border = Color(dark: 0x3B4942, light: 0xDADCD1)
    static let userBubble = Color(dark: 0x23312D, light: 0xE8EFE7)
    static let sunken = Color(dark: 0x101815, light: 0xF0F0E9)

    static let text      = Color(dark: 0xF4F2E8, light: 0x202F29)
    static let secondary = Color(dark: 0xC3CBC0, light: 0x4C5D54)
    static let tertiary  = Color(dark: 0xABB9AC, light: 0x5C695F)

    static let accent = Color(dark: 0xA8D9BB, light: 0x285941)
    static let gold   = Color(dark: 0xE7BE85, light: 0x805326)
    static let green  = Color(dark: 0x91D3B1, light: 0x216945)
    static let sage   = Color(dark: 0x26352D, light: 0xE8EDDF)
    static let clay   = Color(dark: 0x332E26, light: 0xF3EBDE)

    static let readingWidth: CGFloat = 680
    static func title(_ style: Font.TextStyle) -> Font {
        .system(style, design: .serif).weight(.medium)
    }

    // Status pips — defined in Shared/GlanceColors so the widget extension (which
    // can't see Theme) renders identical status colors (review I1/B23).
    static let working = GlanceColors.working
    static let waiting = GlanceColors.waiting
    static let danger  = GlanceColors.error
    static let done    = GlanceColors.done
    static let idle    = GlanceColors.idle

    static let cardRadius: CGFloat = 20
    static let hairline: CGFloat = 0.75

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
    var padding: CGFloat = 16
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius).strokeBorder(Theme.border, lineWidth: Theme.hairline))
    }
}

extension View {
    func consoleCard(padding: CGFloat = 16) -> some View { modifier(ConsoleCard(padding: padding)) }

    /// Apply the same paper canvas to native lists, forms and scroll views.
    func consoleBackground() -> some View {
        self.scrollContentBackground(.hidden)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgDeep.ignoresSafeArea())
    }
}

/// Status pip — replaces the hand-rolled `Circle().fill(stateColor(...))` dots.
///
/// Colour alone carries no meaning for VoiceOver or a colour-blind reader
/// (review D1), so a dot that is the *only* carrier of a status must be given a
/// `label`. A dot sitting next to text that already says the same thing passes
/// none and is hidden from the accessibility tree instead of read as "circle".
struct StatusDot: View {
    let color: Color
    var size: CGFloat = 10
    var label: String? = nil
    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .accessibilityHidden(label == nil)
            .accessibilityLabel(label ?? "")
    }
}

/// Themed capsule pill — same call shape as the old `Pill` (text + color).
struct ThemePill: View {
    let text: String
    var color: Color = Theme.accent
    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(color.opacity(0.08), in: Capsule())
            .foregroundStyle(color)
            .overlay(Capsule().strokeBorder(color.opacity(0.3), lineWidth: Theme.hairline))
    }
}

/// One stat cell in the Dispatch stat strip (count above, label below).
struct StatCell: View {
    let value: Int?
    let label: String
    var tint: Color = Theme.accent
    private var display: String { value.map(String.init) ?? "—" }
    var body: some View {
        VStack(spacing: 2) {
            Text(display).font(.title3.weight(.medium)).foregroundStyle(tint)
            Text(LocalizedStringKey(label)).font(.caption2).foregroundStyle(Theme.tertiary)
        }
        .frame(maxWidth: .infinity)
        .consoleCard(padding: 10)
        // "Needs you: 2", not "2" then "needs you" as two stray elements (D5).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(display)")
    }
}

/// Server portraits use the same header authentication as API calls. Putting
/// the token in a query string both leaks it into URLs and changes the asset
/// filename on older LISA servers, which respond with 404.
struct ServerPortrait: View {
    let client: LisaClient
    let path: String
    @State private var image: UIImage?
    @State private var animation: UIImage?
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var canAnimate: Bool { visible && scenePhase == .active && !reduceMotion }

    private var request: URLRequest? { try? client.makeRequest(path, timeout: 15) }

    var body: some View {
        Group {
            if let image { PortraitImage(image: image, animation: animation, playing: canAnimate) }
            else { Image(systemName: "person.crop.circle.fill").resizable().scaledToFit().foregroundStyle(Theme.secondary) }
        }
        .task(id: request) {
            guard request != nil else { return }
            do {
                let next = try await LisaArtwork.load(client: client, path: path)
                try Task.checkCancellation()
                if let next { image = next }
            } catch { /* Keep the fallback; a later request or reconnect retries. */ }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false; animation = nil }
        .task(id: "\(request?.url?.absoluteString ?? "")|\(canAnimate)") {
            // Only this task owns `animation`. Clearing it from the still-image
            // task could land after a cached animation and leave a still.
            animation = nil
            guard canAnimate else { return }
            do {
                let next = try await LisaArtwork.motion(client: client, path: path)
                try Task.checkCancellation()
                animation = next
            } catch { /* The static atlas remains visible on old servers or failed loads. */ }
        }
    }
}

struct PortraitImage: UIViewRepresentable {
    let image: UIImage
    let animation: UIImage?
    let playing: Bool

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.contentMode = .scaleAspectFit
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        return view
    }
    func updateUIView(_ view: UIImageView, context: Context) {
        let next = playing ? (animation ?? image) : (animation?.images?.first ?? image)
        if view.image !== next {
            view.stopAnimating()
            // Clear first: UIKit can otherwise retain an animated image when
            // the replacement static image shares its first CGImage.
            view.image = nil
            view.image = next
        }
        if playing && animation != nil { if !view.isAnimating { view.startAnimating() } }
        else { view.stopAnimating() }
    }
    static func dismantleUIView(_ view: UIImageView, coordinator: ()) {
        view.stopAnimating()
        view.image = nil
    }
}
