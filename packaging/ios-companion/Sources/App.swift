import SwiftUI

@main
struct LisaPocketApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(app)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var app: AppState
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
        .onOpenURL { app.handleDeepLink($0) }
    }
}
