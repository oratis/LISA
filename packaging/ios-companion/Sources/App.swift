import SwiftUI

@main
struct LisaPocketApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(app)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        TabView(selection: $app.selectedTab) {
            RosterView()
                .tabItem { Label("Dispatch", systemImage: "cpu") }.tag(0)
            ChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }.tag(1)
            ReveView()
                .tabItem { Label("Reve", systemImage: "moon.stars") }.tag(2)
            SenseView()
                .tabItem { Label("Sense", systemImage: "sensor.tag.radiowaves.forward") }.tag(3)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }.tag(4)
        }
        .tint(Theme.accent)                                  // cyan active tab + links + controls
        .preferredColorScheme(.dark)                         // force the console dark look
        .toolbarBackground(Theme.panel, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .onOpenURL { app.handleDeepLink($0) }
        .overlay { if app.locked { LockView() } }
        // Redact the app-switcher / multitasking snapshot: iOS captures the frame
        // at `.inactive` (before `.background`), so a cover keyed on "not active"
        // keeps the token field / chat out of the thumbnail (review A6). Transient
        // interruptions (banner, Control Center) just flash the cover — no Face ID,
        // unlike the biometric lock which arms only on a real `.background`.
        .overlay { if scenePhase != .active { PrivacyCover() } }
        .overlay(alignment: .bottom) {
            if let t = app.toast {
                ToastView(message: t)
                    .padding(.bottom, 72)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .fullScreenCover(isPresented: $app.showOnboarding) {
            OnboardingFlow().environmentObject(app)
        }
        .safeAreaInset(edge: .top) {
            // Persistent nudge after a skip, while still unpaired — taps re-enter the flow.
            if app.needsSetup && !app.showOnboarding {
                SetupBanner { app.presentOnboarding() }
            }
        }
        .task { await app.refreshWidgetSnapshot() }          // keep the widget fresh off-tab (A5)
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { app.lockIfEnabled() }  // re-arm when leaving foreground
            if phase == .active { Task { await app.refreshWidgetSnapshot() } }
        }
    }
}

/// A transient action-feedback toast (AppState.notify).
struct ToastMessage: Equatable, Identifiable {
    let id = UUID()
    var text: String
    var ok: Bool
}

struct ToastView: View {
    let message: ToastMessage
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: message.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(message.ok ? Theme.green : Theme.danger)
            Text(message.text).font(.subheadline).foregroundStyle(Theme.text).lineLimit(2)
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .background(Theme.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 3)
        .padding(.horizontal, 24)
    }
}

/// Opaque branded cover shown whenever the scene isn't active, so the iOS
/// app-switcher snapshot can't expose the token field / chat (review A6).
struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Theme.bgDeep.ignoresSafeArea()
            Image(systemName: "macbook.and.iphone")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Theme.accent)
        }
        .accessibilityHidden(true)
    }
}
