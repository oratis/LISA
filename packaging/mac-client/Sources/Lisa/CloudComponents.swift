import AppKit
import SwiftUI

enum CloudStyle {
    static let appearanceChanged = Notification.Name("ai.meetlisa.appearanceChanged")

    // D-18: follow active theme — Cyan (#6ad4ff) in dark (Nebula), Indigo (#4f5bd5) in light (Calm).
    static let accent = Color(nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return isDark
            ? NSColor(srgbRed: 106.0 / 255.0, green: 212.0 / 255.0, blue: 1.0, alpha: 1.0)
            : NSColor(srgbRed: 79.0 / 255.0, green: 91.0 / 255.0, blue: 213.0 / 255.0, alpha: 1.0)
    })
    static let onAccent = Color(nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return isDark
            ? NSColor(srgbRed: 10.0 / 255.0, green: 16.0 / 255.0, blue: 36.0 / 255.0, alpha: 1.0)
            : .white
    })
    static let background = Color(nsColor: .windowBackgroundColor)
    static let card = Color(nsColor: .controlBackgroundColor)
    static let border = Color.primary.opacity(0.08)

    static var savedAppearance: NSAppearance? {
        switch UserDefaults.standard.string(forKey: "lisaAppearancePreference") {
        case "calm": return NSAppearance(named: .aqua)
        case "nebula": return NSAppearance(named: .darkAqua)
        default: return nil
        }
    }
}

struct CloudCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        let surface = RoundedRectangle(cornerRadius: 16, style: .continuous)
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background { surface.fill(CloudStyle.card).shadow(color: .black.opacity(0.06), radius: 4, y: 2) }
            .overlay { surface.strokeBorder(CloudStyle.border, lineWidth: 1).allowsHitTesting(false) }
    }
}

struct CloudPrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 14, weight: .semibold))
            .frame(maxWidth: .infinity).padding(.horizontal, 16).padding(.vertical, 13)
            .foregroundColor(CloudStyle.onAccent)
            .background(CloudStyle.accent.opacity(configuration.isPressed ? 0.8 : 1),
                        in: RoundedRectangle(cornerRadius: 11))
            .contentShape(RoundedRectangle(cornerRadius: 11))
    }
}

struct CloudHeader: View {
    let symbol: String
    let eyebrow: String
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 13) {
                Image(systemName: symbol).font(.system(size: 23, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(CloudStyle.accent).frame(width: 50, height: 50)
                    .background(CloudStyle.accent.opacity(0.11), in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(eyebrow).font(.system(size: 11, weight: .semibold)).tracking(1.2)
                        .foregroundColor(.secondary)
                    Text(title).font(.system(size: 27, weight: .semibold))
                        .tracking(-0.6).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                }
            }
            Text(subtitle).font(.system(size: 14)).foregroundColor(.secondary)
                .lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct CloudNotice: Equatable {
    enum Kind { case information, success, warning, error }
    let text: String
    var kind: Kind = .information
    var symbol: String {
        switch kind {
        case .information: return "info.circle"
        case .success: return "checkmark.circle.fill"
        case .warning: return "clock"
        case .error: return "exclamationmark.circle"
        }
    }
    var color: Color {
        switch kind {
        case .information: return CloudStyle.accent
        case .success: return .green
        case .warning: return .orange
        case .error: return .red
        }
    }
}

struct CloudNoticeView: View {
    let notice: CloudNotice
    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: notice.symbol).foregroundColor(notice.color).accessibilityHidden(true)
            Text(notice.text).font(.system(size: 12)).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(notice.color.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

struct CloudField<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium)).foregroundColor(.secondary)
            content.textFieldStyle(.plain).font(.system(size: 15))
                .padding(.horizontal, 13).padding(.vertical, 12)
                .background(CloudStyle.background, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(CloudStyle.border, lineWidth: 1))
        }
    }
}

struct CloudStatusRow: View {
    let symbol: String
    let title: String
    let detail: String
    var color: Color = CloudStyle.accent
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.system(size: 18)).foregroundColor(color)
                .frame(width: 32, height: 32)
                .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 14, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(2)
            }
            Spacer(minLength: 0)
        }.accessibilityElement(children: .combine)
    }
}

struct CloudStep: View {
    let number: Int
    let title: String
    let detail: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(String(number)).font(.system(size: 11, weight: .bold))
                .foregroundColor(CloudStyle.accent).frame(width: 24, height: 24)
                .background(CloudStyle.accent.opacity(0.1), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .medium))
                Text(detail).font(.system(size: 12)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }.accessibilityElement(children: .combine)
    }
}

@MainActor
func cloudWindow(title: String, height: CGFloat = 650) -> NSWindow {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: height),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
    window.title = title
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 460, height: 540)
    window.appearance = CloudStyle.savedAppearance
    NotificationCenter.default.addObserver(
        forName: CloudStyle.appearanceChanged, object: nil, queue: .main
    ) { [weak window] _ in
        MainActor.assumeIsolated {
            window?.appearance = CloudStyle.savedAppearance
        }
    }
    window.center()
    return window
}
