import SwiftUI

/// Full-screen gate shown while `app.locked` (docs/IOS_COMPANION_PLAN.md §5.3 —
/// the token is a full-control credential, so an optional Face ID / passcode lock
/// guards it). Auto-prompts on appear; a manual Unlock retries after a cancel.
struct LockView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "lock.fill").font(.largeTitle).foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text("Lisa Pocket is locked").font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Button { Task { await app.unlock() } } label: {
                    Label("Unlock", systemImage: "faceid")
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("Unlock")
                .accessibilityHint("Asks for Face ID or your passcode")
            }
        }
        .task { await app.unlock() }
    }
}
