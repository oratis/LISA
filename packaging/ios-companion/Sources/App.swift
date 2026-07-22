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
        // Four primary tabs (redesign direction B): Home (glanceable dashboard of
        // Lisa) · Chat · Agents (the roster) · Settings. Tags: Home=0, Chat=1,
        // Agents=2, Settings=3 — deep links + the Home 'Agents' card target tag 2.
        TabView(selection: $app.selectedTab) {
            HomeView()
                .tabItem { Label("Home", systemImage: "house") }.tag(0)
            ChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }.tag(1)
            RosterView()
                .tabItem { Label("Agents", systemImage: "cpu") }.tag(2)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }.tag(3)
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
        .safeAreaInset(edge: .top) {
            // Left the Mac's Wi-Fi (LAN pairing + on cellular) → the Mac is
            // unreachable; offer the one-tap escape to LISA Cloud (R3/R4).
            if app.lanUnreachableOnCellular && !app.showOnboarding {
                ReachabilityBanner { app.switchToCloud() }
            }
        }
        .task { await app.refreshWidgetSnapshot() }          // keep the widget fresh off-tab (A5)
        // Unfinished-purchase listener (B5): StoreKit re-delivers transactions
        // the server never credited; the server-side dedup makes replays safe.
        .task { CreditsStore.shared.start(app: app) }
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

/// Top banner shown when paired to a home-Wi-Fi address but on cellular — the Mac
/// is unreachable. Offers the one-tap escape to LISA Cloud (Tailscale is the other
/// path, but that needs a Mac-side re-pair). See docs/PLAN_IOS_REACHABILITY R3/R4.
struct ReachabilityBanner: View {
    let onUseCloud: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text("You've left your Mac's Wi-Fi")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                Text("Reach it over Tailscale, or use LISA Cloud.")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
            Spacer(minLength: 8)
            Button("Use Cloud", action: onUseCloud)
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderedProminent).tint(Theme.accent)
        }
        .padding(.horizontal, 16).padding(.vertical, 9)
        .background(Theme.card)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
        .accessibilityElement(children: .combine)
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
