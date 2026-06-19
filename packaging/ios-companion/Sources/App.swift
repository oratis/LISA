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
    var body: some View {
        TabView {
            RosterView()
                .tabItem { Label("Dispatch", systemImage: "cpu") }
            ChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
            ReveView()
                .tabItem { Label("Reve", systemImage: "moon.stars") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
