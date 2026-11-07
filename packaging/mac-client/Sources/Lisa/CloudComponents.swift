import AppKit
import SwiftUI

enum CloudStyle {
    static let accent = Color(red: 0.45, green: 0.35, blue: 0.95)
    static let background = Color(nsColor: .windowBackgroundColor)
    static let card = Color(nsColor: .controlBackgroundColor)
    static let border = Color.primary.opacity(0.08)
}

struct CloudCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(CloudStyle.card, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(CloudStyle.border, lineWidth: 1))
    }
}

struct CloudPrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 14, weight: .semibold))
            .frame(maxWidth: .infinity).padding(.horizontal, 16).padding(.vertical, 13)
            .foregroundColor(.white)
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 19, weight: .medium))
                    .foregroundColor(CloudStyle.accent).frame(width: 42, height: 42)
                    .background(CloudStyle.accent.opacity(0.11), in: RoundedRectangle(cornerRadius: 13))
                    .accessibilityHidden(true)
                Text(eyebrow).font(.system(size: 11, weight: .semibold)).tracking(1.5)
                    .foregroundColor(.secondary)
            }
            Text(title).font(.system(size: 29, weight: .bold, design: .rounded))
                .tracking(-0.6).accessibilityAddTraits(.isHeader)
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
                .frame(width: 26, height: 26).accessibilityHidden(true)
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
    window.center()
    return window
}
