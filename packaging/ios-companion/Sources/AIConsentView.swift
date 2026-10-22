import SwiftUI

// The in-app disclosure + permission screen for third-party AI processing
// (App Store Guideline 5.1.1(i) / 5.1.2(i)). Renders what `AIDisclosure`
// returns — all the wording and the gate logic live there, under test.
//
// Shown before the FIRST message can leave the phone, and re-readable any time
// from Settings → Privacy → "AI processing & data sharing".

// ── The reusable body: what is sent, who gets it, what never leaves ─────────

struct AIDisclosureBody: View {
    let disclosure: AIDisclosure

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            section("Where it goes", icon: "arrow.turn.down.right") {
                Text(disclosure.route)
                    .font(.subheadline).foregroundStyle(Theme.secondary)
                if disclosure.recipientsUnknown {
                    Text(disclosure.unknownRecipientNote)
                        .font(.footnote).foregroundStyle(Theme.secondary)
                        .padding(Theme.Space.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
                } else {
                    ForEach(disclosure.recipients) { RecipientCard(recipient: $0) }
                }
            }

            section("What is sent", icon: "paperplane") {
                ForEach(AIDisclosure.dataSent, id: \.self) { bullet($0, tint: Theme.secondary) }
            }

            section("What is never sent", icon: "hand.raised") {
                ForEach(AIDisclosure.dataNotSent, id: \.self) { bullet($0, tint: Theme.green) }
            }

            VStack(alignment: .leading, spacing: Theme.Space.s) {
                Text(AIDisclosure.protectionNote)
                    .font(.footnote).foregroundStyle(Theme.secondary)
                Link(destination: AIDisclosure.privacyPolicyURL) {
                    Label("Read our privacy policy", systemImage: "arrow.up.right.square")
                        .font(.footnote.weight(.semibold))
                }
            }
        }
    }

    @ViewBuilder
    private func section<C: View>(_ title: String, icon: String,
                                  @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Label(title, systemImage: icon)
                .font(.headline).foregroundStyle(Theme.text)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func bullet(_ text: String, tint: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            Image(systemName: "circle.fill").font(.system(size: 5)).foregroundStyle(tint)
            Text(text).font(.subheadline).foregroundStyle(Theme.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// One named AI company: who they are, the model + endpoint + where they
/// process it, and a link to their own policy.
private struct RecipientCard: View {
    let recipient: AIRecipient

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            Text(recipient.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
            if !recipient.detail.isEmpty {
                Text(recipient.detail).font(.caption).foregroundStyle(Theme.tertiary)
            }
            if let url = recipient.policyURL {
                Link(destination: url) {
                    Text("\(recipient.name) privacy policy")
                        .font(.caption.weight(.semibold))
                }
                .padding(.top, 1)
            }
        }
        .padding(Theme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .strokeBorder(Theme.border, lineWidth: Theme.hairline))
        .accessibilityElement(children: .combine)
    }
}

// ── The permission ask ──────────────────────────────────────────────────────

/// Blocking consent sheet. Nothing has been sent when this appears and nothing
/// is sent unless `onAgree` runs — "Not now" leaves the message in the box.
/// Interactive dismissal is off on purpose: the user makes an explicit choice.
struct AIConsentSheet: View {
    let disclosure: AIDisclosure
    let onAgree: () -> Void
    let onDecline: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.l) {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        Image(systemName: "sparkles.rectangle.stack")
                            .font(.largeTitle).foregroundStyle(Theme.accent)
                        Text(disclosure.headline)
                            .font(.title2.weight(.bold)).foregroundStyle(Theme.text)
                        Text("Lisa can't answer without one. Read what that involves, then decide.")
                            .font(.subheadline).foregroundStyle(Theme.secondary)
                    }
                    AIDisclosureBody(disclosure: disclosure)
                }
                .padding(Theme.Space.l)
            }
            .background(Theme.bgDeep)
            .navigationTitle("Before you send")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: Theme.Space.s) {
                    Button(action: onAgree) {
                        Text("I agree — send my messages")
                            .font(.headline)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint("Allows Lisa to send what you write to the AI service named above")
                    Button("Not now", action: onDecline)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity).padding(.vertical, 6)
                        .accessibilityHint("Sends nothing. Your message stays on this iPhone")
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.bottom, Theme.Space.m)
                .background(.ultraThinMaterial)
            }
        }
        .interactiveDismissDisabled()
    }
}

// ── The always-available copy (Settings → Privacy) ──────────────────────────

/// The same disclosure, readable (and withdrawable) at any time — so the
/// agreement is never a one-shot dialog the user can't revisit.
struct AIDisclosureDetailView: View {
    @EnvironmentObject var app: AppState
    @State private var showRevokeConfirm = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                statusCard
                AIDisclosureBody(disclosure: app.aiDisclosure)
                if !app.needsAIConsent {
                    Button("Withdraw permission", role: .destructive) { showRevokeConfirm = true }
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
                }
            }
            .padding(Theme.Space.l)
        }
        .background(Theme.bgDeep)
        .navigationTitle("AI processing")
        .navigationBarTitleDisplayMode(.inline)
        .task { await app.refreshAIDisclosure() }
        .confirmationDialog("Withdraw permission?", isPresented: $showRevokeConfirm, titleVisibility: .visible) {
            Button("Withdraw", role: .destructive) {
                app.revokeAIConsent()
                app.notify("Permission withdrawn — nothing will be sent until you agree again.")
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Lisa stops sending anything to the AI service. She'll ask again the next time you send a message.")
        }
    }

    private var statusCard: some View {
        let granted = !app.needsAIConsent
        return HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            Image(systemName: granted ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(granted ? Theme.green : Theme.gold)
            VStack(alignment: .leading, spacing: 2) {
                Text(granted ? "You agreed to AI processing" : "Not agreed — nothing is being sent")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                Text(granted ? grantedDetail : "Lisa will ask before your first message leaves this iPhone.")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        .padding(Theme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
        .accessibilityElement(children: .combine)
    }

    private var grantedDetail: String {
        guard let at = app.aiConsent?.grantedAt else { return "" }
        return "On \(at.formatted(date: .abbreviated, time: .shortened)), for \(app.connectionMode.label)."
    }
}
