import SwiftUI
import UIKit

// Shared chrome for the onboarding screens (docs/PLAN_IOS_ONBOARDING_v1.0.md).
// Small composable pieces rather than one big generic scaffold, so each screen
// reads top-to-bottom and compiles cleanly.

/// Tasteful haptics for the flow — a success tap on copy / connect, a warning on a
/// failed connect, a selection tick when picking a card.
enum Haptics {
    static func success()   { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning()   { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func selection() { UISelectionFeedbackGenerator().selectionChanged() }
}

/// Progress dots for the dotted sub-sequence (install → connect). Hidden for the
/// pre-flow steps (welcome / mode) and the cloud branch by passing `step: nil`.
struct OnboardingDots: View {
    let step: OnboardingStep?
    var body: some View {
        HStack(spacing: 7) {
            ForEach(OnboardingStep.dotted, id: \.rawValue) { s in
                Capsule()
                    .fill(isActive(s) ? Theme.accent : Theme.border)
                    .frame(width: isCurrent(s) ? 18 : 7, height: 7)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: step)
    }
    private func isCurrent(_ s: OnboardingStep) -> Bool { s == step }
    private func isActive(_ s: OnboardingStep) -> Bool {
        guard let step else { return false }
        return s.rawValue <= step.rawValue
    }
}

/// Top bar: progress dots (optional) on the left, a "Not now" skip on the right.
struct OnboardingTopBar: View {
    var step: OnboardingStep?
    var onSkip: (() -> Void)?
    var body: some View {
        HStack {
            if step != nil { OnboardingDots(step: step) }
            Spacer()
            if let onSkip {
                Button("Not now", action: onSkip)
                    .font(.subheadline)
                    .foregroundStyle(Theme.tertiary)
            }
        }
        .frame(height: 28)
        .padding(.horizontal, 24)
        .padding(.top, 8)
    }
}

/// Big title + optional subtitle block.
struct OnboardingTitle: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.title.weight(.bold))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                Text(subtitle)
                    .font(.body)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
    }
}

/// A monospaced terminal command in a card with a tap-to-copy button. Shows a
/// transient "Copied" state + a success haptic.
struct CopyCommandRow: View {
    let command: String
    @State private var copied = false
    var body: some View {
        HStack(spacing: 10) {
            Text(command)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
            Button(action: copy) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .foregroundStyle(copied ? Theme.green : Theme.accent)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "Copied" : "Copy command")
        }
        .padding(.vertical, 12).padding(.horizontal, 14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius).strokeBorder(Theme.border, lineWidth: Theme.hairline))
        .padding(.horizontal, 24)
    }
    private func copy() {
        UIPasteboard.general.string = command
        Haptics.success()
        withAnimation { copied = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation { copied = false }
        }
    }
}

/// A selectable card (the My Mac / LISA Cloud + install-method choices).
struct OnboardingChoiceCard: View {
    let systemImage: String
    let title: String
    let subtitle: String
    var badge: String? = nil
    var selected: Bool = false
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: { Haptics.selection(); action() }) {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(disabled ? Theme.tertiary : Theme.accent)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(title).font(.headline).foregroundStyle(Theme.text)
                        if let badge { ThemePill(text: badge, color: Theme.green) }
                    }
                    Text(subtitle).font(.subheadline).foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent) }
            }
            .padding(14)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cardRadius)
                    .strokeBorder(selected ? Theme.accent : Theme.border, lineWidth: selected ? 1.5 : Theme.hairline)
            )
            .opacity(disabled ? 0.5 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .padding(.horizontal, 24)
    }
}

/// Primary cyan CTA pinned at the bottom of a screen.
struct OnboardingPrimaryButton: View {
    let title: String
    var disabled: Bool = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.bgDeep)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.5 : 1)
        .disabled(disabled)
        .padding(.horizontal, 24)
    }
}

/// Secondary text link under the primary CTA (the escape hatches).
struct OnboardingSecondaryButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.accent)
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
    }
}

/// The persistent "Finish setup" banner shown over the app when the user skipped
/// onboarding but still isn't paired. Tapping it re-enters the flow.
struct SetupBanner: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                Text("Finish setting up — connect to your Mac")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.caption.weight(.bold))
            }
            .foregroundStyle(Theme.bgDeep)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Theme.accent)
        }
        .buttonStyle(.plain)
    }
}
